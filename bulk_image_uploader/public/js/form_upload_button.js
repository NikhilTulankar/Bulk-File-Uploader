// 1. Adds an "Upload Files" button to every form: opens the Bulk File Upload
//    page with this DocType and record already selected.
// 2. Adds "Upload Files" to every list view's Actions menu: tick several
//    records, click it, and the page opens with one row per record.
(function () {
	let allowed = null; // cached per session

	function can_use() {
		if (allowed === null) {
			allowed = frappe
				.xcall("bulk_image_uploader.api.can_use_page")
				.catch(() => false);
		}
		return allowed;
	}

	$(document).on("form-refresh", function (e, frm) {
		if (!frm || !frm.doc || frm.is_new() || frm.meta.issingle || frm.meta.istable) return;
		if (frm.doctype === "Bulk Image Uploader Settings" || frm.doctype === "File") return;
		if (!frm.perm || !frm.perm[0] || !frm.perm[0].write) return;

		can_use().then((ok) => {
			if (!ok) return;
			frm.add_custom_button(__("Upload Files"), () => {
				frappe.route_options = { doctype: frm.doctype, record: frm.doc.name };
				frappe.set_route("bulk-image-upload");
			});
		});
	});

	function add_list_action() {
		const list = window.cur_list;
		const route = frappe.get_route() || [];
		if (!list || route[0] !== "List" || list.doctype !== route[1] || !list.page) return;
		if (list.__bfu_action || list.doctype === "File") return;
		if (!frappe.model.can_write(list.doctype)) return;
		if (frappe.get_meta(list.doctype) && (frappe.get_meta(list.doctype).issingle || frappe.get_meta(list.doctype).istable)) return;

		can_use().then((ok) => {
			if (!ok || list.__bfu_action) return;
			list.__bfu_action = true;
			list.page.add_actions_menu_item(
				__("Upload Files"),
				() => {
					const names = list.get_checked_items(true);
					if (!names.length) {
						frappe.msgprint(__("Tick one or more records first."));
						return;
					}
					frappe.route_options = { doctype: list.doctype, records: names.join("\n") };
					frappe.set_route("bulk-image-upload");
				},
				false
			);
		});
	}

	function schedule_list_action() {
		// the list view is built asynchronously after the route changes
		[500, 1500, 3000].forEach((ms) => setTimeout(add_list_action, ms));
	}

	$(document).on("app_ready", schedule_list_action);
	if (frappe.router && frappe.router.on) frappe.router.on("change", schedule_list_action);
	$(schedule_list_action);
})();
