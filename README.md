# Bulk File Uploader for ERPNext / Frappe v15+

This app uploads many files at once (images, PDF, Word, Excel and so on) to **any DocType** and links them to records. It has three modes:

- **Upload to one record**: pick a DocType and a record, then add any number of files. All of them are attached to that record.
- **Multiple records (pick files per row)**: a table with one row per record. Each row has its own files, and one click uploads everything.
- **Match files to records by file name**: `ITEM-001.jpg` goes to Item `ITEM-001`, `ITEM-002.jpg` to `ITEM-002`, and so on. This is useful for bulk item images.

Files can be stored **locally**, **directly in Amazon S3** (or any S3-compatible service), or through Frappe's normal upload handling, which also works with apps such as `frappe_s3_attachment`.

## Install

```bash
cd ~/frappe-bench
# Option 1: from your own git repo (needed for Frappe Cloud)
bench get-app https://github.com/<you>/bulk_image_uploader.git
# Option 2: from this folder
cp -r /path/to/bulk_image_uploader apps/
bench setup requirements          # installs boto3
echo "bulk_image_uploader" >> sites/apps.txt   # only if it is not already listed

bench --site yoursite install-app bulk_image_uploader
bench --site yoursite migrate
bench build --app bulk_image_uploader   # for the "Upload Files" button on forms
bench restart
```

**Upgrading from an earlier version:** run `migrate`, `bench build --app bulk_image_uploader` and `restart`. Then open **Bulk Image Uploader Settings**. If **Allowed Extensions** still only lists image types, add `pdf, doc, docx, xls, xlsx` and any others you need, or empty the field to allow every file type.

## Upload files to one record

There are two ways to start:

- Open any saved record, for example an Item, Customer, Employee or Purchase Invoice, and click **Upload Files**. The page opens with that DocType and record already selected.
- Or open `/app/bulk-image-upload`, keep **Mode = Upload to one record**, choose the **DocType**, then choose the **record**.

Then:

1. Click **Select Files** or **Select Folder**, or drag and drop the files. Any type is accepted, as long as it is in the Allowed Extensions list.
2. Optionally set **Also set this field**, for example Image on an Item. An image is also put in that field. Other files, such as PDFs, are only attached.
3. Optionally set **File Privacy**: *Private* is a good choice for documents such as invoices or ID proofs.
4. Click **Start Upload**. When it finishes, click **Open <record>** to see the files in the record's attachments sidebar.

## Upload files to many records in one click

There are two ways to start:

- In any **list view** (for example Customer), tick the records you want, then click **Actions → Upload Files**. The page opens in *Multiple records* mode with one row per ticked record.
- Or open `/app/bulk-image-upload`, set **Mode = Multiple records (pick files per row)**, choose the DocType, and use **Add Row** to add as many rows as you need.

In each row, pick the **record**, then click **+ Add Files** or drop files onto that row. Each row can have different files and any number of them. Click **Start Upload**: every file goes to its own row's record. Each file shows its status in the row (green = uploaded, red = error) and in the results table. If you click Start Upload again, only the files that failed are retried.

## Match many files to many records by name

Set **Mode = Match files to records by file name**, choose the DocType, the field to set (for example Image) and the field to match against (ID, item_code, barcode…). Then select the files. Tick **Dry run** first if you want to check which files match a record.

## Configure the storage

Open **Bulk Image Uploader Settings** (`/app/bulk-image-uploader-settings`) and pick a **Storage Backend**:

| Backend | What happens |
|---|---|
| Frappe Default | Frappe's normal upload. If an S3 attachment app is installed, the files go to S3 through that app. Supports private files. |
| Local | The files are always saved in `sites/<site>/public/files` or `private/files`. Any S3 app's hooks are skipped. |
| Amazon S3 | The files are uploaded straight to the bucket configured here: bucket, region, optional endpoint (MinIO, Wasabi, DO Spaces, R2), keys (leave them empty to use the IAM role), folder prefix, optional CDN URL. Click **Test S3 Connection** to check it. **Files uploaded this way are always public.** |

> If you already use `frappe_s3_attachment`, choose **Frappe Default**. Your S3 app keeps storing the files, including private documents.

## Command line

```bash
# All files in a folder -> one record
bench --site yoursite bulk-image-upload --doctype Customer --record "CUST-0001" --folder /home/frappe/docs --private

# Match by file name (bulk item images)
bench --site yoursite bulk-image-upload --doctype Item --folder /home/frappe/item_images
# other options: --image-field image  --match-field item_code  --attach-only  --overwrite  --dry-run
```

## Notes

- Only System Manager can use the page and the **Upload Files** button by default. To give other roles access, open **Page → bulk-image-upload** and add the roles there. Users also need write permission on the target DocType and record.
- Upload failures are recorded in **Error Log**.
- The site's own `max_file_size` (in site_config.json, 25 MB by default) still applies on top of the limit in Settings.
