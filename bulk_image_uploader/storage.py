"""Storage backends for Bulk Image Uploader.

Backends
--------
Frappe Default : Normal Frappe file handling. If an S3 attachment app
                 (e.g. frappe_s3_attachment) is installed, its hooks run
                 and the file goes wherever that app sends it.
Local          : Always writes to the site's public/private files folder,
                 bypassing other apps' File hooks.
Amazon S3      : Uploads directly with boto3 using the credentials in
                 Bulk Image Uploader Settings (works with AWS S3 and
                 S3-compatible services: MinIO, Wasabi, DO Spaces, R2...).
"""

import hashlib
import mimetypes
import os
import re
from urllib.parse import quote

import frappe
from frappe import _
from frappe.utils import cint, now_datetime


def save_file(content, filename, doctype, docname, fieldname, settings, is_private=None):
	"""Store `content` and create a File record attached to doctype/docname.

	`is_private` overrides the setting (ignored for direct S3, which is public).
	Returns the file URL.
	"""
	backend = settings.storage_backend or "Frappe Default"
	if backend == "Amazon S3":
		is_private = 0
	elif is_private is None:
		is_private = cint(settings.is_private)
	else:
		is_private = cint(is_private)

	if backend == "Frappe Default":
		file_doc = frappe.get_doc(
			{
				"doctype": "File",
				"file_name": filename,
				"attached_to_doctype": doctype,
				"attached_to_name": docname,
				"attached_to_field": fieldname,
				"is_private": is_private,
				"content": content,
			}
		)
		file_doc.insert(ignore_permissions=True)
		# Other apps (e.g. S3 attachment apps) may rewrite file_url after insert
		file_doc.reload()
		return file_doc.file_url

	if backend == "Local":
		file_url, stored_name = _write_local(content, filename, is_private)
	elif backend == "Amazon S3":
		file_url, stored_name = _upload_s3(content, filename, doctype, settings)
	else:
		frappe.throw(_("Unknown storage backend: {0}").format(backend))

	_insert_file_record(stored_name, file_url, content, is_private, doctype, docname, fieldname)
	return file_url


def safe_filename(filename):
	name = os.path.basename(filename.replace("\\", "/"))
	name = re.sub(r"\s+", "-", name.strip())
	name = re.sub(r"[^\w\-.]", "_", name)
	return name or frappe.generate_hash(length=10)


def _write_local(content, filename, is_private):
	folder = frappe.get_site_path("private" if is_private else "public", "files")
	os.makedirs(folder, exist_ok=True)

	name = safe_filename(filename)
	base, ext = os.path.splitext(name)
	candidate = name
	while os.path.exists(os.path.join(folder, candidate)):
		candidate = f"{base}{frappe.generate_hash(length=6)}{ext}"

	with open(os.path.join(folder, candidate), "wb") as f:
		f.write(content)

	prefix = "/private/files/" if is_private else "/files/"
	return prefix + candidate, candidate


def get_s3_client(settings):
	try:
		import boto3
	except ImportError:
		frappe.throw(_("boto3 is not installed. Run: bench pip install boto3"))

	kwargs = {}
	if settings.s3_region:
		kwargs["region_name"] = settings.s3_region.strip()
	if settings.s3_endpoint_url:
		kwargs["endpoint_url"] = settings.s3_endpoint_url.strip()
	if settings.s3_access_key_id:
		kwargs["aws_access_key_id"] = settings.s3_access_key_id.strip()
		kwargs["aws_secret_access_key"] = settings.get_password(
			"s3_secret_access_key", raise_exception=False
		)
	# If no keys are given, boto3 falls back to env vars / IAM role.
	return boto3.client("s3", **kwargs)


def _upload_s3(content, filename, doctype, settings):
	if not settings.s3_bucket:
		frappe.throw(_("Set the S3 Bucket in Bulk Image Uploader Settings"))

	bucket = settings.s3_bucket.strip()
	name = safe_filename(filename)
	base, ext = os.path.splitext(name)
	content_hash = hashlib.md5(content).hexdigest()
	stored_name = f"{base}-{content_hash[:8]}{ext}"

	prefix = (settings.s3_folder_prefix or "").strip("/ ")
	key = "/".join(p for p in (prefix, frappe.scrub(doctype), stored_name) if p)

	extra = {"ContentType": mimetypes.guess_type(name)[0] or "application/octet-stream"}
	if cint(settings.s3_public_read):
		extra["ACL"] = "public-read"

	client = get_s3_client(settings)
	client.put_object(Bucket=bucket, Key=key, Body=content, **extra)

	encoded_key = quote(key, safe="/")
	if settings.s3_public_base_url:
		url = f"{settings.s3_public_base_url.strip().rstrip('/')}/{encoded_key}"
	elif settings.s3_endpoint_url:
		url = f"{settings.s3_endpoint_url.strip().rstrip('/')}/{bucket}/{encoded_key}"
	elif settings.s3_region:
		url = f"https://{bucket}.s3.{settings.s3_region.strip()}.amazonaws.com/{encoded_key}"
	else:
		url = f"https://{bucket}.s3.amazonaws.com/{encoded_key}"

	return url, stored_name


def _insert_file_record(file_name, file_url, content, is_private, doctype, docname, fieldname):
	"""Insert a File row directly, skipping File hooks so that other storage
	apps do not move or re-upload the file."""
	now = now_datetime()
	folder = "Home/Attachments" if frappe.db.exists("File", "Home/Attachments") else "Home"

	file_doc = frappe.new_doc("File")
	file_doc.update(
		{
			"file_name": file_name,
			"file_url": file_url,
			"is_private": is_private,
			"is_folder": 0,
			"folder": folder,
			"file_size": len(content),
			"content_hash": hashlib.md5(content).hexdigest(),
			"attached_to_doctype": doctype,
			"attached_to_name": docname,
			"attached_to_field": fieldname,
			"owner": frappe.session.user,
			"modified_by": frappe.session.user,
			"creation": now,
			"modified": now,
		}
	)
	file_doc.name = frappe.generate_hash(length=10)
	file_doc.db_insert()
	return file_doc
