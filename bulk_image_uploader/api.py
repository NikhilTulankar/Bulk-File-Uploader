import os

import frappe
from frappe import _
from frappe.utils import cint

from bulk_image_uploader.storage import save_file

ATTACH_ONLY = "__attach_only__"
IMAGE_FIELDTYPES = ("Attach Image", "Attach")
MATCH_FIELDTYPES = ("Data", "Link", "Barcode", "Read Only", "Int")
SETTINGS = "Bulk Image Uploader Settings"


def _check_doctype(doctype):
	if not doctype or not frappe.db.exists("DocType", doctype):
		frappe.throw(_("DocType {0} not found").format(doctype))
	meta = frappe.get_meta(doctype)
	if meta.issingle or meta.istable:
		frappe.throw(_("Single and child table DocTypes are not supported"))
	if not frappe.has_permission(doctype, "write"):
		frappe.throw(_("You do not have write permission on {0}").format(doctype), frappe.PermissionError)
	return meta


@frappe.whitelist()
def can_use_page():
	"""True if the current user's roles allow the Bulk File Upload page."""
	if frappe.session.user == "Guest":
		return False
	try:
		return bool(frappe.get_doc("Page", "bulk-image-upload").is_permitted())
	except Exception:
		return False


@frappe.whitelist()
def get_doctype_fields(doctype):
	"""Return image fields and match fields for the upload page."""
	meta = _check_doctype(doctype)

	image_fields = [
		{"value": df.fieldname, "label": f"{_(df.label)} ({df.fieldname})"}
		for df in meta.fields
		if df.fieldtype in IMAGE_FIELDTYPES
	]
	image_fields.append({"value": ATTACH_ONLY, "label": _("Attach only (don't set any field)")})

	match_fields = [{"value": "name", "label": _("ID (name)")}]
	match_fields += [
		{"value": df.fieldname, "label": f"{_(df.label)} ({df.fieldname})"}
		for df in meta.fields
		if df.fieldtype in MATCH_FIELDTYPES and df.fieldname != "name"
	]

	default_image = meta.image_field or (image_fields[0]["value"] if len(image_fields) > 1 else ATTACH_ONLY)
	return {
		"image_fields": image_fields,
		"match_fields": match_fields,
		"default_image_field": default_image,
	}


@frappe.whitelist(methods=["POST"])
def upload_image(
	doctype,
	image_field=None,
	match_field="name",
	overwrite=0,
	dry_run=0,
	filename=None,
	record=None,
	is_private=None,
):
	"""Upload one file (multipart field `file`).

	- With `record`: attach the file to that record.
	- Without `record`: find the record whose `match_field` equals the file name.
	"""
	uploaded = frappe.request.files.get("file") if frappe.request else None
	if uploaded:
		filename = uploaded.filename
		content = uploaded.stream.read()
	elif cint(dry_run) and filename:
		content = None
	else:
		frappe.throw(_("No file received"))

	return process_image(
		doctype,
		filename,
		content,
		image_field=image_field,
		match_field=match_field or "name",
		overwrite=cint(overwrite),
		dry_run=cint(dry_run),
		record=record or None,
		is_private=None if is_private in (None, "") else cint(is_private),
	)


def _resolve_image_field(meta, image_field, required=True):
	if image_field == ATTACH_ONLY:
		return None
	if not image_field:
		if not required:
			return None
		if not meta.image_field:
			frappe.throw(_("{0} has no default image field. Choose a field or 'Attach only'.").format(meta.name))
		return meta.image_field
	df = meta.get_field(image_field)
	if not df or df.fieldtype not in IMAGE_FIELDTYPES:
		frappe.throw(_("{0} is not an Attach / Attach Image field").format(image_field))
	return image_field


def _find_record(meta, match_field, value):
	if match_field == "name":
		return frappe.db.exists(meta.name, value)
	if not meta.get_field(match_field):
		frappe.throw(_("Field {0} not found in {1}").format(match_field, meta.name))
	names = frappe.get_all(meta.name, filters={match_field: value}, pluck="name", limit=2)
	if len(names) > 1:
		frappe.throw(_("More than one {0} has {1} = {2}").format(meta.name, match_field, value))
	return names[0] if names else None


IMAGE_EXTENSIONS = ("jpg", "jpeg", "png", "webp", "gif", "bmp", "svg", "tif", "tiff", "avif")


def process_image(
	doctype,
	filename,
	content,
	image_field=None,
	match_field="name",
	overwrite=False,
	dry_run=False,
	record=None,
	is_private=None,
):
	"""Core logic shared by the upload page and the bench command.

	Works for any file type. The file is always attached to the record; the
	chosen field is set only when it fits (images for Attach Image fields).
	"""
	result = {"file": filename, "record": record, "status": "error", "message": "", "file_url": None}
	try:
		settings = frappe.get_single(SETTINGS)
		meta = _check_doctype(doctype)

		basename = os.path.basename((filename or "").replace("\\", "/"))
		stem, ext = os.path.splitext(basename)
		ext = ext.lower().lstrip(".")

		allowed = settings.get_allowed_extensions()
		if allowed and ext not in allowed:
			result.update(status="skipped", message=_("File type .{0} is not allowed").format(ext or "?"))
			return result

		max_mb = cint(settings.max_file_size_mb)
		if content is not None and max_mb and len(content) > max_mb * 1024 * 1024:
			result.update(status="skipped", message=_("File is larger than {0} MB").format(max_mb))
			return result

		fieldname = _resolve_image_field(meta, image_field, required=not record)

		if record:
			name = frappe.db.exists(doctype, record)
			if not name:
				result.update(status="not_found", message=_("{0} {1} not found").format(doctype, record))
				return result
		else:
			name = _find_record(meta, match_field, stem.strip())
			if not name:
				result.update(
					status="not_found",
					message=_("No {0} with {1} = {2}").format(doctype, match_field, stem),
				)
				return result
		result["record"] = name

		if not frappe.has_permission(doctype, "write", doc=name):
			result["message"] = _("No write permission on {0}").format(name)
			return result

		# Decide whether this file should also go into the field
		set_field = None
		note = ""
		if fieldname:
			df = meta.get_field(fieldname)
			if df.fieldtype == "Attach Image" and ext not in IMAGE_EXTENSIONS:
				note = _("not an image, so the field was not set")
			elif not overwrite and frappe.db.get_value(doctype, name, fieldname):
				if not record:
					result.update(status="skipped", message=_("Already has an image (tick Overwrite to replace)"))
					return result
				note = _("field already has a value")
			else:
				set_field = fieldname

		if dry_run:
			result.update(status="ready", message=_("Will be linked"))
			return result

		file_url = save_file(content, basename, doctype, name, set_field, settings, is_private=is_private)
		if set_field:
			frappe.db.set_value(doctype, name, set_field, file_url)
			msg = _("Attached and set in {0}").format(set_field)
		else:
			msg = _("Attached")
		if note:
			msg += f" ({note})"

		result.update(status="success", file_url=file_url, message=msg)
	except Exception as e:
		frappe.db.rollback()
		result.update(status="error", message=str(e) or e.__class__.__name__)
		frappe.log_error(title=f"Bulk Upload failed: {filename}", message=frappe.get_traceback())
	return result
