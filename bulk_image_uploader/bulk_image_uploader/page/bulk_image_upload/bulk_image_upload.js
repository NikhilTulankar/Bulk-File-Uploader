frappe.pages["bulk-image-upload"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: __("Bulk File Upload"),
		single_column: true,
	});
	wrapper.bulk_upload = new BulkFileUpload(page);
};

frappe.pages["bulk-image-upload"].on_page_show = function (wrapper) {
	// Opened from a form's "Upload Files" button: /app/bulk-image-upload?doctype=Item&record=ITEM-001
	// From the list view's Actions menu: ?doctype=Item&records=ITEM-001\nITEM-002
	const opts = frappe.route_options || {};
	frappe.route_options = null;
	if (wrapper.bulk_upload && opts.doctype) {
		let records = opts.records || [];
		if (typeof records === "string") records = records.split("\n").filter(Boolean);
		wrapper.bulk_upload.preset(opts.doctype, opts.record, records);
	}
};

const BFU_MODE_RECORD = "Upload to one record";
const BFU_MODE_MULTI = "Multiple records (pick files per row)";
const BFU_MODE_MATCH = "Match files to records by file name";
const BFU_ATTACH_ONLY = "__attach_only__";
const BFU_CONCURRENCY = 3;
const BFU_STATUS = {
	pending: { label: __("Pending"), color: "gray" },
	uploading: { label: __("Uploading"), color: "blue" },
	ready: { label: __("Ready"), color: "blue" },
	success: { label: __("Uploaded"), color: "green" },
	skipped: { label: __("Skipped"), color: "orange" },
	not_found: { label: __("Not Found"), color: "red" },
	error: { label: __("Error"), color: "red" },
};

class BulkFileUpload {
	constructor(page) {
		this.page = page;
		this.files = [];
		this.results = [];
		this.running = false;
		this.last_doctype = null;
		this.make();
	}

	is_record_mode() {
		// one record or multiple records: files go to records chosen on screen
		return this.form.get_value("mode") !== BFU_MODE_MATCH;
	}

	is_multi_mode() {
		return this.form.get_value("mode") === BFU_MODE_MULTI;
	}

	make() {
		this.$body = $(`
			<div class="bfu">
				<div class="bfu-form"></div>
				<div class="bfu-rows-card frappe-card p-4 mb-4" style="display: none;"></div>
				<div class="bfu-picker-card frappe-card p-4 mb-4">
					<div class="d-flex flex-wrap" style="gap: 8px;">
						<button class="btn btn-default btn-sm bfu-pick-files">${__("Select Files")}</button>
						<button class="btn btn-default btn-sm bfu-pick-folder">${__("Select Folder")}</button>
						<button class="btn btn-default btn-sm bfu-clear">${__("Clear")}</button>
						<input type="file" class="bfu-input-files" multiple hidden>
						<input type="file" class="bfu-input-folder" webkitdirectory multiple hidden>
					</div>
					<div class="bfu-dropzone mt-3 p-4 text-center text-muted"
						style="border: 2px dashed var(--border-color); border-radius: var(--border-radius-md);">
						${__("Or drop files here (images, PDF, Word, Excel…)")}
					</div>
					<div class="bfu-selected mt-2 text-muted">${__("No files selected")}</div>
					<div class="bfu-hint text-muted small mt-2"></div>
				</div>
				<div class="bfu-summary mb-3"></div>
				<div class="bfu-results"></div>
			</div>
		`).appendTo(this.page.main);

		this.form = new frappe.ui.FieldGroup({
			body: this.$body.find(".bfu-form").get(0),
			fields: [
				{
					fieldname: "mode",
					label: __("Mode"),
					fieldtype: "Select",
					options: [BFU_MODE_RECORD, BFU_MODE_MULTI, BFU_MODE_MATCH].join("\n"),
					default: BFU_MODE_RECORD,
					reqd: 1,
					change: () => this.on_mode_change(),
				},
				{ fieldtype: "Column Break" },
				{ fieldtype: "Section Break" },
				{
					fieldname: "doctype",
					label: __("DocType"),
					fieldtype: "Link",
					options: "DocType",
					reqd: 1,
					get_query: () => ({ filters: { istable: 0, issingle: 0 } }),
					change: () => this.load_fields(),
				},
				{
					fieldname: "record",
					label: __("Record"),
					fieldtype: "Link",
					options: "",
					depends_on: `eval:doc.mode=="${BFU_MODE_RECORD}"`,
					read_only_depends_on: "eval:!doc.doctype",
					mandatory_depends_on: `eval:doc.mode=="${BFU_MODE_RECORD}"`,
					description: __("Select the DocType first"),
					change: () => this.update_hint(),
				},
				{ fieldtype: "Column Break" },
				{
					fieldname: "image_field",
					label: __("Also set this field"),
					fieldtype: "Select",
					description: __("Files are always attached to the record. Pick a field to also store the image link in it."),
				},
				{
					fieldname: "match_field",
					label: __("Match File Name With"),
					fieldtype: "Select",
					options: [{ label: __("ID (name)"), value: "name" }],
					default: "name",
					depends_on: `eval:doc.mode=="${BFU_MODE_MATCH}"`,
				},
				{ fieldtype: "Section Break" },
				{
					fieldname: "privacy",
					label: __("File Privacy"),
					fieldtype: "Select",
					options: [
						{ label: __("As in Settings"), value: "" },
						{ label: __("Public"), value: "0" },
						{ label: __("Private"), value: "1" },
					],
					default: "",
					description: __("Private is ignored when storage is direct Amazon S3"),
				},
				{ fieldtype: "Column Break" },
				{
					fieldname: "overwrite",
					label: __("Overwrite the field if it already has a value"),
					fieldtype: "Check",
				},
				{
					fieldname: "dry_run",
					label: __("Dry run (check matches only, nothing is uploaded)"),
					fieldtype: "Check",
					depends_on: `eval:doc.mode=="${BFU_MODE_MATCH}"`,
				},
			],
		});
		this.form.make();

		this.page.set_primary_action(__("Start Upload"), () => this.start(), "upload");
		this.page.set_secondary_action(__("Settings"), () =>
			frappe.set_route("Form", "Bulk Image Uploader Settings")
		);
		this.page.add_menu_item(__("Download Results (CSV)"), () => this.download_csv());

		this.bind_picker();
		this.make_rows_ui();
		this.update_hint();
	}

	async preset(doctype, record, records) {
		const multi = records && records.length > 1;
		await this.form.set_value("mode", multi ? BFU_MODE_MULTI : BFU_MODE_RECORD);
		await this.form.set_value("doctype", doctype);
		await this.load_fields();
		if (multi) {
			this.clear_rows();
			records.forEach((r) => this.add_row(r));
		} else {
			const one = record || (records && records[0]);
			if (one) await this.form.set_value("record", one);
		}
		this.on_mode_change();
	}

	on_mode_change() {
		this.form.refresh_dependency();
		const multi = this.is_multi_mode();
		this.$body.find(".bfu-rows-card").toggle(multi);
		this.$body.find(".bfu-picker-card").toggle(!multi);
		if (multi && !this.rows.length) this.add_row();
		this.apply_field_default();
		this.update_hint();
	}

	// ---------- Multiple records: one row per record ----------

	make_rows_ui() {
		this.rows = [];
		this.row_seq = 0;
		this.$rows_card = this.$body.find(".bfu-rows-card");
		this.$rows_card.html(`
			<div class="d-flex justify-content-between align-items-start flex-wrap mb-3" style="gap: 8px;">
				<div>
					<div class="font-weight-bold">${__("Records and their files")}</div>
					<div class="text-muted small">${__("Pick a record in each row and add its files (you can also drop files onto a row). Then click Start Upload.")}</div>
				</div>
				<div class="d-flex" style="gap: 8px;">
					<button class="btn btn-default btn-sm bfu-add-row">${__("Add Row")}</button>
					<button class="btn btn-default btn-sm bfu-clear-rows">${__("Clear All")}</button>
				</div>
			</div>
			<div class="bfu-rows"></div>
			<div class="bfu-rows-total text-muted small mt-2"></div>
		`);
		this.$rows_card.find(".bfu-add-row").on("click", () => !this.running && this.add_row());
		this.$rows_card.find(".bfu-clear-rows").on("click", () => {
			if (this.running) return;
			this.clear_rows();
			this.add_row();
		});
	}

	clear_rows() {
		this.rows = [];
		this.$rows_card.find(".bfu-rows").empty();
		this.results = [];
		this.$body.find(".bfu-results, .bfu-summary").empty();
		this.update_rows_total();
	}

	add_row(record) {
		const row = { id: ++this.row_seq, files: [], status: [] };
		const $row = $(`
			<div class="bfu-row d-flex align-items-start p-2 mb-2"
				style="gap: 12px; border: 1px solid var(--border-color); border-radius: var(--border-radius-md);">
				<div class="bfu-row-no text-muted pt-2" style="width: 22px;"></div>
				<div class="bfu-row-record" style="width: 280px; flex-shrink: 0;"></div>
				<div class="flex-fill" style="min-width: 0;">
					<div class="d-flex align-items-center flex-wrap pt-1" style="gap: 8px;">
						<button class="btn btn-default btn-xs bfu-row-add">${__("+ Add Files")}</button>
						<span class="text-muted small">${__("or drop files on this row")}</span>
						<input type="file" class="bfu-row-input" multiple hidden>
					</div>
					<div class="bfu-row-files d-flex flex-wrap mt-2" style="gap: 6px;"></div>
				</div>
				<button class="btn btn-link btn-xs text-muted bfu-row-remove" title="${__("Remove row")}">✕</button>
			</div>
		`).appendTo(this.$rows_card.find(".bfu-rows"));
		row.$row = $row;

		row.control = frappe.ui.form.make_control({
			df: {
				fieldtype: "Link",
				fieldname: `bfu_record_${row.id}`,
				options: this.form.get_value("doctype") || "",
				placeholder: __("Select record"),
			},
			parent: $row.find(".bfu-row-record"),
			render_input: true,
			only_input: true,
		});
		row.control.refresh();
		row.control.$input.on("change awesomplete-selectcomplete", () => setTimeout(() => this.update_rows_total(), 50));
		if (record) row.control.set_value(record);

		const $input = $row.find(".bfu-row-input");
		$row.find(".bfu-row-add").on("click", () => !this.running && $input.trigger("click"));
		$input.on("change", (e) => {
			this.add_row_files(row, e.target.files);
			e.target.value = "";
		});
		$row.on("dragover", (e) => {
			e.preventDefault();
			$row.css("background", "var(--subtle-fg)");
		});
		$row.on("dragleave", () => $row.css("background", ""));
		$row.on("drop", (e) => {
			e.preventDefault();
			$row.css("background", "");
			this.add_row_files(row, e.originalEvent.dataTransfer.files);
		});
		$row.find(".bfu-row-remove").on("click", () => {
			if (this.running) return;
			this.rows = this.rows.filter((r) => r !== row);
			$row.remove();
			this.renumber_rows();
		});

		this.rows.push(row);
		this.renumber_rows();
		return row;
	}

	renumber_rows() {
		this.rows.forEach((r, i) => r.$row.find(".bfu-row-no").text(i + 1));
		this.update_rows_total();
	}

	add_row_files(row, file_list) {
		if (this.running) return;
		const existing = new Set(row.files.map((f) => f.name + "|" + f.size));
		Array.from(file_list || []).forEach((f) => {
			if (f.size > 0 && !f.name.startsWith(".") && !existing.has(f.name + "|" + f.size)) {
				row.files.push(f);
				row.status.push("pending");
			}
		});
		this.render_row_files(row);
		this.update_rows_total();
	}

	render_row_files(row) {
		const esc = frappe.utils.escape_html;
		const $files = row.$row.find(".bfu-row-files").empty();
		row.files.forEach((f, i) => {
			const st = row.status[i] || "pending";
			const s = BFU_STATUS[st] || BFU_STATUS.error;
			const removable = !this.running && st !== "success";
			const $chip = $(`
				<span class="indicator-pill ${s.color}" title="${esc(s.label)}" style="max-width: 100%;">
					<span class="ellipsis" style="max-width: 220px;">${esc(f.name)}</span>
					${removable ? `<a class="bfu-chip-remove ml-1" style="cursor: pointer;">✕</a>` : ""}
				</span>
			`).appendTo($files);
			$chip.find(".bfu-chip-remove").on("click", () => {
				row.files.splice(i, 1);
				row.status.splice(i, 1);
				this.render_row_files(row);
				this.update_rows_total();
			});
		});
	}

	update_rows_total() {
		if (!this.$rows_card) return;
		const with_files = this.rows.filter((r) => r.files.length);
		const total = with_files.reduce((n, r) => n + r.files.length, 0);
		this.$rows_card
			.find(".bfu-rows-total")
			.text(__("{0} row(s), {1} file(s) to upload", [this.rows.length, total]));
	}

	refresh_rows_doctype(changed) {
		const doctype = this.form.get_value("doctype") || "";
		(this.rows || []).forEach((r) => {
			r.control.df.options = doctype;
			if (changed) r.control.set_value("");
		});
	}

	update_hint() {
		const doctype = this.form.get_value("doctype");
		const record = this.form.get_value("record");
		let hint;
		if (this.is_multi_mode()) {
			hint = "";
		} else if (this.is_record_mode()) {
			hint = record
				? __("All selected files will be attached to {0} {1}.", [__(doctype), `<b>${frappe.utils.escape_html(record)}</b>`])
				: __("Choose a DocType and a record, then select any files to attach to it.");
		} else {
			hint = __("Each file name (without extension) must equal the Match Field value, e.g. ITEM-001.jpg → Item ITEM-001.");
		}
		this.$body.find(".bfu-hint").html(hint);
	}

	bind_picker() {
		const $files = this.$body.find(".bfu-input-files");
		const $folder = this.$body.find(".bfu-input-folder");
		this.$body.find(".bfu-pick-files").on("click", () => $files.trigger("click"));
		this.$body.find(".bfu-pick-folder").on("click", () => $folder.trigger("click"));
		this.$body.find(".bfu-clear").on("click", () => this.set_files([]));

		[$files, $folder].forEach(($input) => {
			$input.on("change", (e) => {
				this.add_files(e.target.files);
				e.target.value = "";
			});
		});

		const $drop = this.$body.find(".bfu-dropzone");
		$drop.on("dragover", (e) => {
			e.preventDefault();
			$drop.css("background", "var(--subtle-fg)");
		});
		$drop.on("dragleave", () => $drop.css("background", ""));
		$drop.on("drop", (e) => {
			e.preventDefault();
			$drop.css("background", "");
			this.add_files(e.originalEvent.dataTransfer.files);
		});
	}

	add_files(file_list) {
		if (this.running) return;
		const existing = new Set(this.files.map((f) => f.name + "|" + f.size));
		const added = Array.from(file_list || []).filter(
			(f) => f.size > 0 && !f.name.startsWith(".") && !existing.has(f.name + "|" + f.size)
		);
		this.set_files(this.files.concat(added));
	}

	set_files(files) {
		if (this.running) return;
		this.files = files;
		const size_mb = files.reduce((s, f) => s + f.size, 0) / (1024 * 1024);
		const $sel = this.$body.find(".bfu-selected");
		if (!files.length) {
			$sel.addClass("text-muted").text(__("No files selected"));
		} else {
			const names = files.slice(0, 5).map((f) => frappe.utils.escape_html(f.name)).join(", ");
			const more = files.length > 5 ? " " + __("and {0} more", [files.length - 5]) : "";
			$sel.removeClass("text-muted").html(
				`<b>${__("{0} file(s) selected, {1} MB", [files.length, size_mb.toFixed(1)])}</b>
				<div class="text-muted small">${names}${more}</div>`
			);
		}
		this.results = [];
		this.$body.find(".bfu-results, .bfu-summary").empty();
	}

	load_fields() {
		const doctype = this.form.get_value("doctype");
		if (!doctype) return Promise.resolve();
		if (doctype === this.last_doctype && this.loading) return this.loading;
		this.last_doctype = doctype;
		this.loading = this._load_fields(doctype);
		return this.loading;
	}

	async _load_fields(doctype) {

		// Point the Record link(s) at the chosen DocType
		const changed = this.loaded_doctype && this.loaded_doctype !== doctype;
		this.loaded_doctype = doctype;
		this.refresh_rows_doctype(changed);
		this.form.set_df_property("record", "options", doctype);
		this.form.set_df_property("record", "label", __("{0} (record)", [__(doctype)]));
		this.form.set_df_property("record", "description", "");
		this.form.set_value("record", "");

		try {
			const r = await frappe.call({
				method: "bulk_image_uploader.api.get_doctype_fields",
				args: { doctype },
			});
			this.field_info = r.message || {};
			this.form.set_df_property("image_field", "options", this.field_info.image_fields || []);
			this.form.set_df_property("match_field", "options", this.field_info.match_fields || []);
			this.form.set_value("match_field", "name");
			this.apply_field_default();
		} catch (e) {
			this.last_doctype = null;
			this.loading = null;
		}
		this.update_hint();
	}

	apply_field_default() {
		if (!this.field_info) return;
		// One record: just attach by default. Match mode: fill the image field.
		const value = this.is_record_mode() ? BFU_ATTACH_ONLY : this.field_info.default_image_field;
		this.form.set_value("image_field", value);
	}

	build_tasks(values) {
		if (this.is_multi_mode()) {
			const tasks = [];
			const missing = [];
			this.rows.forEach((row, ri) => {
				const record = (row.control.get_value() || "").trim();
				const pending = row.files.filter((_, fi) => row.status[fi] !== "success");
				if (pending.length && !record) missing.push(ri + 1);
				row.files.forEach((file, fi) => {
					if (row.status[fi] !== "success") tasks.push({ file, record, row, fi });
				});
			});
			if (missing.length) {
				frappe.msgprint(__("Please select a record in row(s): {0}", [missing.join(", ")]));
				return null;
			}
			return tasks;
		}
		if (this.is_record_mode()) {
			if (!values.record) {
				frappe.msgprint(__("Please select the record to attach the files to."));
				return null;
			}
			return this.files.map((file) => ({ file, record: values.record }));
		}
		return this.files.map((file) => ({ file, record: null }));
	}

	async start() {
		if (this.running) return;
		const values = this.form.get_values();
		if (!values) return;
		const tasks = this.build_tasks(values);
		if (!tasks) return;
		if (!tasks.length) {
			frappe.msgprint(__("Please add files first."));
			return;
		}

		this.running = true;
		this.page.btn_primary.prop("disabled", true);
		this.run_values = values;
		this.results = tasks.map((tk) => ({
			file: tk.file.name,
			status: "pending",
			record: tk.record || "",
			message: "",
			file_url: "",
		}));
		this.render_table();
		(this.rows || []).forEach((r) => this.render_row_files(r));

		const total = tasks.length;
		let next = 0;
		let done = 0;
		this.update_summary(done, total);

		const set_status = (i, status) => {
			const tk = tasks[i];
			if (tk.row) {
				tk.row.status[tk.fi] = status;
				this.render_row_files(tk.row);
			}
		};

		const worker = async () => {
			while (next < total) {
				const i = next++;
				this.results[i].status = "uploading";
				this.update_row(i);
				set_status(i, "uploading");
				this.results[i] = await this.upload_one(tasks[i].file, values, tasks[i].record);
				done++;
				this.update_row(i);
				set_status(i, this.results[i].status);
				this.update_summary(done, total);
			}
		};
		await Promise.all(Array.from({ length: Math.min(BFU_CONCURRENCY, total) }, worker));

		this.running = false;
		this.page.btn_primary.prop("disabled", false);
		(this.rows || []).forEach((r) => this.render_row_files(r));
		frappe.show_alert({ message: __("Upload finished"), indicator: "green" });

		if (!this.is_multi_mode() && this.is_record_mode() && values.record) {
			this.show_open_record(values.doctype, values.record);
		}
	}

	show_open_record(doctype, record) {
		const $btn = $(`<button class="btn btn-default btn-sm ml-2">${__("Open {0}", [frappe.utils.escape_html(record)])}</button>`);
		$btn.on("click", () => frappe.set_route("Form", doctype, record));
		this.$body.find(".bfu-summary > div:last").append($btn);
	}

	async upload_one(file, values, record) {
		const record_mode = !!record;
		const fd = new FormData();
		const dry = !record_mode && values.dry_run;
		if (dry) {
			fd.append("filename", file.name);
		} else {
			fd.append("file", file, file.name);
		}
		fd.append("doctype", values.doctype);
		fd.append("image_field", values.image_field || (record_mode ? BFU_ATTACH_ONLY : ""));
		fd.append("match_field", values.match_field || "name");
		fd.append("overwrite", values.overwrite ? 1 : 0);
		fd.append("dry_run", dry ? 1 : 0);
		fd.append("is_private", values.privacy || "");
		if (record_mode) fd.append("record", record);

		try {
			const r = await fetch("/api/method/bulk_image_uploader.api.upload_image", {
				method: "POST",
				body: fd,
				headers: { "X-Frappe-CSRF-Token": frappe.csrf_token, Accept: "application/json" },
			});
			const data = await r.json().catch(() => ({}));
			if (r.ok && data.message) return data.message;
			return { file: file.name, status: "error", record: record || "", message: this.extract_error(data, r) };
		} catch (e) {
			return { file: file.name, status: "error", record: record || "", message: e.message || String(e) };
		}
	}

	extract_error(data, response) {
		try {
			if (data._server_messages) {
				const msgs = JSON.parse(data._server_messages).map((m) => {
					try {
						return JSON.parse(m).message;
					} catch (e) {
						return m;
					}
				});
				return $("<div>").html(msgs.join(" ")).text();
			}
		} catch (e) {
			/* ignore */
		}
		if (data.exception) return data.exception;
		if (response.status === 413) return __("File too large for the server");
		return response.statusText || __("Upload failed");
	}

	render_table() {
		const esc = frappe.utils.escape_html;
		const rows = this.results
			.map(
				(r, i) => `
				<tr>
					<td>${i + 1}</td>
					<td>${esc(r.file)}</td>
					<td class="bfu-status"></td>
					<td class="bfu-record"></td>
					<td class="bfu-message text-muted"></td>
				</tr>`
			)
			.join("");
		this.$body.find(".bfu-results").html(`
			<div class="frappe-card p-0" style="max-height: 60vh; overflow: auto;">
				<table class="table table-sm mb-0">
					<thead><tr>
						<th>#</th><th>${__("File")}</th><th>${__("Status")}</th>
						<th>${__("Record")}</th><th>${__("Message")}</th>
					</tr></thead>
					<tbody>${rows}</tbody>
				</table>
			</div>
		`);
		this.$rows = this.$body.find(".bfu-results tbody tr");
		this.results.forEach((_, i) => this.update_row(i));
	}

	update_row(i) {
		const r = this.results[i];
		const $row = $(this.$rows[i]);
		const s = BFU_STATUS[r.status] || BFU_STATUS.error;
		const doctype = this.run_values ? this.run_values.doctype : this.form.get_value("doctype");
		$row.find(".bfu-status").html(`<span class="indicator-pill ${s.color}">${s.label}</span>`);
		$row.find(".bfu-record").html(
			r.record
				? `<a href="/app/${frappe.router.slug(doctype)}/${encodeURIComponent(r.record)}" target="_blank">${frappe.utils.escape_html(r.record)}</a>`
				: ""
		);
		const $msg = $row.find(".bfu-message").text(r.message || "");
		if (r.file_url) {
			$msg.append(` · <a href="${encodeURI(r.file_url)}" target="_blank">${__("View file")}</a>`);
		}
	}

	update_summary(done, total) {
		const counts = {};
		this.results.forEach((r) => (counts[r.status] = (counts[r.status] || 0) + 1));
		const pct = total ? Math.round((done / total) * 100) : 0;
		const pills = Object.keys(BFU_STATUS)
			.filter((k) => counts[k] && !["pending", "uploading"].includes(k))
			.map((k) => `<span class="indicator-pill ${BFU_STATUS[k].color} mr-2">${BFU_STATUS[k].label}: ${counts[k]}</span>`)
			.join("");
		this.$body.find(".bfu-summary").html(`
			<div class="progress mb-2" style="height: 8px;">
				<div class="progress-bar" style="width: ${pct}%;"></div>
			</div>
			<div class="d-flex align-items-center flex-wrap">${__("{0} of {1} processed", [done, total])} &nbsp; ${pills}</div>
		`);
	}

	download_csv() {
		if (!this.results.length) {
			frappe.msgprint(__("Nothing to download yet."));
			return;
		}
		const quote = (v) => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
		const lines = [["File", "Status", "Record", "File URL", "Message"].map(quote).join(",")];
		this.results.forEach((r) =>
			lines.push([r.file, r.status, r.record, r.file_url, r.message].map(quote).join(","))
		);
		const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
		const a = document.createElement("a");
		a.href = URL.createObjectURL(blob);
		a.download = "bulk_upload_results.csv";
		a.click();
		URL.revokeObjectURL(a.href);
	}
}
