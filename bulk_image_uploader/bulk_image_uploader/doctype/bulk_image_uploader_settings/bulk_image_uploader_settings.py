import frappe
from frappe import _
from frappe.model.document import Document

DEFAULT_EXTENSIONS = (
	"jpg", "jpeg", "png", "webp", "gif",
	"pdf", "doc", "docx", "xls", "xlsx", "csv", "ppt", "pptx", "odt", "ods", "txt", "zip",
)


class BulkImageUploaderSettings(Document):
	def validate(self):
		if (self.allowed_extensions or "").strip():
			self.allowed_extensions = ", ".join(self.get_allowed_extensions())
		if self.s3_folder_prefix:
			self.s3_folder_prefix = self.s3_folder_prefix.strip("/ ")

	def get_allowed_extensions(self):
		"""Empty list means every file type is allowed."""
		raw = self.allowed_extensions
		if raw is None:
			raw = ", ".join(DEFAULT_EXTENSIONS)
		return [e.strip().lower().lstrip(".") for e in raw.replace(";", ",").split(",") if e.strip()]

	@frappe.whitelist()
	def test_s3_connection(self):
		frappe.only_for("System Manager")
		from bulk_image_uploader.storage import get_s3_client

		saved = frappe.get_single("Bulk Image Uploader Settings")
		if not saved.s3_bucket:
			frappe.throw(_("Save the settings with a Bucket Name first"))
		try:
			get_s3_client(saved).head_bucket(Bucket=saved.s3_bucket.strip())
		except Exception as e:
			frappe.throw(_("Could not reach bucket {0}: {1}").format(saved.s3_bucket, e))
		return _("Connected to bucket {0} successfully").format(saved.s3_bucket)
