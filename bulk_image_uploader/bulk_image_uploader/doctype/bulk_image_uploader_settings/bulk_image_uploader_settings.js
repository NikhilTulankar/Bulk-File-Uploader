frappe.ui.form.on("Bulk Image Uploader Settings", {
	refresh(frm) {
		frm.add_custom_button(__("Open Bulk Image Upload"), () => frappe.set_route("bulk-image-upload"));
		if (frm.doc.storage_backend === "Amazon S3") {
			frm.add_custom_button(__("Test S3 Connection"), () => {
				if (frm.is_dirty()) {
					frappe.msgprint(__("Please save the settings first."));
					return;
				}
				frm.call("test_s3_connection").then((r) => {
					if (r.message) frappe.msgprint({ message: r.message, indicator: "green" });
				});
			});
		}
	},
	storage_backend(frm) {
		frm.trigger("refresh");
	},
});
