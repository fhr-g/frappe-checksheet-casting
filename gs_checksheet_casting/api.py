import frappe
import pymssql
import json
from confluent_kafka import Consumer, KafkaError
from frappe.utils import now_datetime

@frappe.whitelist()
def sync_master_mesin():
	count_insert = 0
	count_update = 0

	try:
		# 1. Buka koneksi ke MSSQL
		conn = pymssql.connect(
			server='gsportal-DEV01',
			user='dev01_faris',
			password='Kopiapayangasin@2026!',
			database='db_maintenance'
		)
		cursor = conn.cursor(as_dict=True)

		# 2. Tarik semua data
		query = """
			SELECT
				id,
				mesin_nama,
				mesin_nomor
			FROM tlkp_mesin
			WHERE
				mesin_statusDel = '1' 
				AND section_id = '5' 
				AND mesin_nama LIKE 'Casting Machine -%'
		"""
		cursor.execute(query)
		data = cursor.fetchall()

		# 3. Looping untuk Upsert
		for row in data:
			mesin_id = str(row['id'])

			if frappe.db.exists("Mesin", mesin_id):
				doc = frappe.get_doc("Mesin", mesin_id)
				doc.mesin_nama = row['mesin_nama']
				doc.mesin_nomor = row['mesin_nomor']
				doc.save(ignore_permissions=True)
				count_update += 1
			else:
				doc = frappe.new_doc("Mesin")
				doc.id_mesin = mesin_id
				doc.mesin_nama = row['mesin_nama']
				doc.mesin_nomor = row['mesin_nomor']
				doc.insert(ignore_permissions=True)
				count_insert += 1

		frappe.db.commit()
		return {"status": "success", "inserted": count_insert, "updated": count_update}

	except Exception as e:
		# --- PERUBAHAN DI SINI ---
		error_traceback = frappe.get_traceback()
		
		# Catat full traceback ke dalam tabel Error Log Frappe
		frappe.log_error(title="Cronjob Sync Mesin Error", message=error_traceback)
		
		# Tampilkan juga di browser
		return {
			"status": "error", 
			"message": str(e) or "Terjadi error (lihat traceback)", 
			"traceback": error_traceback
		}
	finally:
		if 'conn' in locals() and conn:
			conn.close()


@frappe.whitelist()
def start_kafka_consumer_mesin():
	# 1. Konfigurasi Kafka
	conf = {
		'bootstrap.servers': 'kafka:9092',  # Mengarah ke nama container Kafka
		'group.id': 'frappe-mesin-sync-group',
		'auto.offset.reset': 'earliest'
	}

	consumer = Consumer(conf)
	topic = 'gsportal.db_maintenance.dbo.tlkp_mesin'
	consumer.subscribe([topic])

	print(f"==================================================")
	print(f" KAFKA CDC RAW SQL CONSUMER AKTIF!")
	print(f" Mendengarkan: {topic}")
	print(f"==================================================")

	try:
		while True:
			msg = consumer.poll(timeout=1.0)
			if msg is None:
				continue

			if msg.error():
				if msg.error().code() == KafkaError._PARTITION_EOF:
					continue
				else:
					print(f"Kafka Error: {msg.error()}")
					break

			# 2. Dekode pesan JSON
			msg_value = json.loads(msg.value().decode('utf-8'))
			payload = msg_value.get('payload', {})
			if not payload:
				continue

			op = payload.get('op')  # 'c' = insert, 'u' = update, 'd' = delete

			# LOGIKA A: Penanganan Penghapusan Fisik via RAW SQL DELETE
			if op == 'd':
				before = payload.get('before') or {}
				mesin_id = str(before.get('id'))
				if mesin_id:
					# Bypass ORM: Langsung hapus dari tabel PostgreSQL
					frappe.db.sql('DELETE FROM "tabMesin" WHERE name = %s', (mesin_id,))
					frappe.db.commit()
					
					# PENTING: Bersihkan cache agar UI Frappe langsung tahu data sudah terhapus
					frappe.clear_cache(doctype="Mesin")
					print(f"🗑️ [RAW SQL Delete] Menghapus Mesin ID: {mesin_id}")
				continue

			after = payload.get('after')
			if not after:
				continue

			mesin_id = str(after.get('id'))
			mesin_nama = after.get('mesin_nama')
			mesin_nomor = after.get('mesin_nomor')
			status_del = str(after.get('mesin_statusDel'))
			section_id = str(after.get('section_id'))

			# LOGIKA B: Saring data sesuai SOP Kriteria Anda
			if (status_del == '1' and 
				section_id == '5' and 
				mesin_nama and mesin_nama.startswith("Casting Machine -")):
				
				current_time = now_datetime()

				# Bypass ORM: Gunakan PostgreSQL Native UPSERT (ON CONFLICT)
				# Kita wajib mengisi kolom wajib Frappe: creation, modified, owner, modified_by, docstatus, idx
				query = """
					INSERT INTO "tabMesin" (
						name, creation, modified, owner, modified_by, docstatus, idx, 
						id_mesin, mesin_nama, mesin_nomor
					) VALUES (
						%s, %s, %s, 'Administrator', 'Administrator', 0, 0, 
						%s, %s, %s
					)
					ON CONFLICT (name) DO UPDATE SET 
						mesin_nama = EXCLUDED.mesin_nama, 
						mesin_nomor = EXCLUDED.mesin_nomor,
						modified = EXCLUDED.modified;
				"""
				
				frappe.db.sql(query, (
					mesin_id, current_time, current_time, 
					mesin_id, mesin_nama, mesin_nomor
				))
				frappe.db.commit()

				# PENTING: Bersihkan cache agar dropdown di form langsung menampilkan data terbaru
				frappe.clear_cache(doctype="Mesin")
				print(f"🚀 [RAW SQL Upsert] Sukses memproses Mesin ID: {mesin_id}")
			
			else:
				# LOGIKA C: Hapus jika mesin tidak lagi memenuhi kriteria filter
				if frappe.db.exists("Mesin", mesin_id):
					frappe.db.sql('DELETE FROM "tabMesin" WHERE name = %s', (mesin_id,))
					frappe.db.commit()
					frappe.clear_cache(doctype="Mesin")
					print(f"🛑 [RAW SQL Exclude] Menghapus Mesin ID: {mesin_id} karena di luar filter.")

	except KeyboardInterrupt:
		pass
	finally:
		consumer.close()
		print("Kafka Consumer dihentikan.")