import os

import click
from frappe.commands import get_site, pass_context


@click.command("bulk-image-upload")
@click.option("--doctype", required=True, help="Target DocType, e.g. Item")
@click.option(
	"--folder", required=True, type=click.Path(exists=True, file_okay=False), help="Folder with images"
)
@click.option("--image-field", default=None, help="Image fieldname (default: DocType's image field)")
@click.option("--attach-only", is_flag=True, help="Only attach the file, don't set any field")
@click.option("--match-field", default="name", help="Field to match the file name against (default: name)")
@click.option("--record", default=None, help="Attach ALL files in the folder to this one record")
@click.option("--private", "private", is_flag=True, default=None, help="Save files as private")
@click.option("--overwrite", is_flag=True, help="Replace existing images")
@click.option("--dry-run", is_flag=True, help="Only check matches, don't upload")
@pass_context
def bulk_image_upload(
	context, doctype, folder, image_field, attach_only, match_field, record, private, overwrite, dry_run
):
	"""Upload every file in FOLDER and link it to DOCTYPE records by file name,
	or attach them all to one --record."""
	import frappe

	from bulk_image_uploader.api import ATTACH_ONLY, process_image

	site = get_site(context)
	frappe.init(site=site)
	frappe.connect()
	counts = {}
	try:
		frappe.set_user("Administrator")
		files = sorted(f for f in os.listdir(folder) if os.path.isfile(os.path.join(folder, f)))
		for fname in files:
			with open(os.path.join(folder, fname), "rb") as fh:
				content = fh.read()
			res = process_image(
				doctype,
				fname,
				content,
				image_field=ATTACH_ONLY if attach_only else image_field,
				match_field=match_field,
				overwrite=overwrite,
				dry_run=dry_run,
				record=record,
				is_private=1 if private else None,
			)
			frappe.db.commit()
			counts[res["status"]] = counts.get(res["status"], 0) + 1
			click.echo(f"{res['status']:<10} {fname} -> {res.get('record') or '-'}  {res.get('message') or ''}")
		click.secho("Summary: " + ", ".join(f"{k}={v}" for k, v in sorted(counts.items())), fg="green")
	finally:
		frappe.destroy()


commands = [bulk_image_upload]
