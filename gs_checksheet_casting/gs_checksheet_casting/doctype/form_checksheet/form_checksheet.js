// Copyright (c) 2026, GS and contributors
// For license information, please see license.txt

let handlers = {
	onload: function(frm) {
		// 1. Daftarkan trigger otomatis untuk semua field sampel aktual
		setup_actual_triggers(frm);
	},

	refresh: function(frm) {
		// 2. Terapkan Pembatasan Hak Edit Kolom Berdasarkan Peran & Status (SOP Validasi)
		handle_field_permissions(frm);

		// 3. Evaluasi keterbacaan field 'alasan_lainnya'
		toggle_alasan_lainnya(frm);

		// 4. Render Label Dinamis (Tebal, Lebar, Berat) saat memuat checksheet lama
		if (frm.doc.product_type) {
			fetch_and_update_labels(frm, frm.doc.product_type);
		} else {
			update_section_labels(frm, null);
		}

        evaluate_category(frm, 'tebal', 8);
		evaluate_category(frm, 'lebar', 2);
		evaluate_category(frm, 'berat', 10);
	},

	alasan_permintaan_validasi: function(frm) {
		toggle_alasan_lainnya(frm);
	},

	product_type: function(frm) {
		// 5. Salin nilai ke field 'ke' (Aman dari infinite loop)
		if (frm.doc.product_type !== frm.doc.ke) {
			frm.set_value('ke', frm.doc.product_type || '');
		}

		// 6. Auto-Fetch Standar Spec dari Master Data 'Items' & Render Label Dinamis (Real-time)
		if (frm.doc.product_type) {
			fetch_and_update_labels(frm, frm.doc.product_type, true);
		} else {
			// Reset nilai standar jika tipe barang dikosongkan
			const fields_to_reset = [
				'standar_tebal_min', 'standar_tebal_max',
				'standar_lebar_min', 'standar_lebar_max',
				'standar_berat_min', 'standar_berat_max'
			];
			fields_to_reset.forEach(field => frm.set_value(field, 0));
			update_section_labels(frm, null);
		}
	},

	ke: function(frm) {
		// 7. Sinkronisasi balik ke product_type jika diisi dari field 'ke'
		if (frm.doc.ke !== frm.doc.product_type) {
			frm.set_value('product_type', frm.doc.ke || '');
		}
	},

	// 8. Validasi cegat alur kerja: Bebaskan pencatatan Draft, cegat saat "Kirim Permintaan"
	before_workflow_action: function(frm) {
		if (frm.selected_workflow_action === "Kirim Permintaan") {
			let missing = [];

			if (!frm.doc.mesin) missing.push("Mesin");
			if (!frm.doc.mold || frm.doc.mold.length < 1) missing.push("Mold"); 
			if (!frm.doc.product_type) missing.push("Tipe yang akan diproduksi");
            if (!frm.doc.jenis_pergantian_dari) missing.push("Jenis Pergantian dari");
            if (!frm.doc.ke) missing.push("Ke");
			if (!frm.doc.shift) missing.push("Shift");
			if (!frm.doc.tanggal) missing.push("Tanggal");
			if (!frm.doc.jam) missing.push("Jam");
			if (!frm.doc.alasan_permintaan_validasi) missing.push("Alasan Permintaan Validasi");

			if (frm.doc.alasan_permintaan_validasi === "Lainnya" && !frm.doc.alasan_lainnya) {
				missing.push("Alasan Lainnya");
			}

			if (missing.length > 0) {
				frappe.validated = false; // Batalkan transisi workflow secara paksa
				
				// Fix UI Freeze
				frappe.dom.unfreeze(); 
				
				frappe.throw({
					title: __("Validasi Form Gagal"),
					message: __("Sebelum mengirimkan permintaan validasi ke Inspektor, Anda wajib melengkapi kolom berikut: <br><ul><li>" + missing.join("</li><li>") + "</li></ul>")
				});
			}
		}
	}
};


frappe.ui.form.on('Form Checksheet', handlers);

for (let i = 1; i <= 8; i++) {
	handlers[`tebal_actual_${i}`] = function(frm) {
		evaluate_category(frm, 'tebal', 8);
	};
}

// Mendaftarkan perubahan Lebar (a s/d b) secara native ke Frappe Engine
['a', 'b'].forEach(char => {
	handlers[`lebar_actual_${char}`] = function(frm) {
		evaluate_category(frm, 'lebar', 2);
	};
});

// Mendaftarkan perubahan Berat (1 s/d 10) secara native ke Frappe Engine
for (let i = 1; i <= 10; i++) {
	handlers[`berat_actual_${i}`] = function(frm) {
		evaluate_category(frm, 'berat', 10);
	};
}

// ==========================================
// FUNGSI HELPER / PENDUKUNG (MODULAR)
// ==========================================

// Helper 1: Tarik spesifikasi dari DB Items dan perbarui label serta field standard (FIXED FOR FRAPPE V16)
function fetch_and_update_labels(frm, product_type_id, update_fields = false) {
	frappe.db.get_value('Items', product_type_id, [
		'tebal_grid_min', 'tebal_grid_standard', 'tebal_grid_max',
		'lebar_grid_min', 'lebar_grid_standard', 'lebar_grid_max',
		'berat_grid_min', 'berat_grid_standard', 'berat_grid_max'
	]).then(r => {
		let data = r.message; 
		if (data) {
			if (update_fields) {
				frm.set_value('standar_tebal_min', data.tebal_grid_min);
				frm.set_value('standar_tebal_max', data.tebal_grid_max);
				frm.set_value('standar_lebar_min', data.lebar_grid_min);
				frm.set_value('standar_lebar_max', data.lebar_grid_max);
				frm.set_value('standar_berat_min', data.berat_grid_min);
				frm.set_value('standar_berat_max', data.berat_grid_max);
			}
			update_section_labels(frm, data);

			// FIX 1b: Kirimkan objek 'data' langsung dari database ke fungsi evaluasi (Bypass Async delay)
			evaluate_category(frm, 'tebal', 8, data);
			evaluate_category(frm, 'lebar', 2, data);
			evaluate_category(frm, 'berat', 10, data);
		}
	});
}

// Helper 2: Mengubah Label Section Break Secara Dinamis di Layar (On-The-Fly dengan Dual-Reactivity & DOM Override)
function update_section_labels(frm, data) {
	if (!data) {
		// Reset ke label standar jika data kosong menggunakan dual-override
		force_section_label(frm, 'tebal_grid_section', "Tebal Grid", "Tebal Grid");
		force_section_label(frm, 'lebar_grid_section', "Lebar Grid", "Lebar Grid");
		force_section_label(frm, 'berat_grid_section', "Berat Grid", "Berat Grid");
	} else {
		// Helper pemformat angka desimal (Maksimal 2 desimal, hapus nol tak berguna di belakang)
		const fmt = (val) => Number(parseFloat(val).toFixed(2)).toString();

		// 1. Tebal Grid Label (Contoh: Tebal Grid (std: 1.8±0.1 mm))
		let t_std = parseFloat(data.tebal_grid_standard);
		let t_tol = (parseFloat(data.tebal_grid_max) - parseFloat(data.tebal_grid_min)) / 2;
		if (!isNaN(t_std) && !isNaN(t_tol)) {
			let t_label = `Tebal Grid (std: ${fmt(t_std)}±${fmt(t_tol)} mm)`;
			force_section_label(frm, 'tebal_grid_section', t_label);
		}

		// 2. Lebar Grid Label (Contoh: Lebar Grid (std: 121.4±0.5 mm))
		let l_std = parseFloat(data.lebar_grid_standard);
		let l_tol = (parseFloat(data.lebar_grid_max) - parseFloat(data.lebar_grid_min)) / 2;
		if (!isNaN(l_std) && !isNaN(l_tol)) {
			let l_label = `Lebar Grid (std: ${fmt(l_std)}±${fmt(l_tol)} mm)`;
			force_section_label(frm, 'lebar_grid_section', l_label);
		}

		// 3. Berat Grid Label (Contoh: Berat Grid (std: 137±6 gr))
		let b_std = parseFloat(data.berat_grid_standard);
		let b_tol = (parseFloat(data.berat_grid_max) - parseFloat(data.berat_grid_min)) / 2;
		if (!isNaN(b_std) && !isNaN(b_tol)) {
			let b_label = `Berat Grid (std: ${fmt(b_std)}±${fmt(b_tol)} gr)`;
			force_section_label(frm, 'berat_grid_section', b_label);
		}
	}
}

// Helper Tambahan: Memaksa Perubahan Label di Metadata dan DOM secara bersamaan (Bypass Frappe v16 Vue DOM)
function force_section_label(frm, fieldname, new_label) {
	// 1. Update metadata agar pencetakan/PDF tetap sinkron
	frm.set_df_property(fieldname, 'label', new_label);

	// 2. Cari elemen kepala section-head berdasarkan data-fieldname
	let $head = $(`[data-fieldname="${fieldname}"]`).find('.section-head');
	
	if ($head.length) {
		// Dapatkan semua isi konten di dalam .section-head (termasuk teks dan elemen span)
		let contents = $head.contents();
		
		// Jika anak pertama adalah Text Node (nodeType 3), ubah teksnya secara langsung
		if (contents.length > 0 && contents[0].nodeType === 3) {
			// Kita hanya menimpa teks "Tebal Grid" tanpa merusak tag <span> di dalamnya
			contents[0].nodeValue = `\n\t\t\t${new_label}\n\t\t\t`;
		} else {
			// Fallback jika struktur HTML berubah
			$head.text(new_label);
		}
	}
}

// Helper 3: Mengatur Read-Only field alasan_lainnya
function toggle_alasan_lainnya(frm) {
	if (frm.doc.alasan_permintaan_validasi !== 'Lainnya') {
		frm.set_df_property('alasan_lainnya', 'read_only', 1);
	} else {
		const is_permintaan_locked = frm.doc.workflow_state && frm.doc.workflow_state !== "Draft";
		frm.set_df_property('alasan_lainnya', 'read_only', is_permintaan_locked ? 1 : 0);
	}
}

// Helper 4: Mendaftarkan listener 'onchange' pada seluruh field sampel aktual secara otomatis
function setup_actual_triggers(frm) {
	// Triggers Tebal (1 s/d 8)
	for (let i = 1; i <= 8; i++) {
		if (frm.fields_dict[`tebal_actual_${i}`]) {
			frm.fields_dict[`tebal_actual_${i}`].df.onchange = () => evaluate_category(frm, 'tebal', 8);
		}
	}

	// Triggers Lebar (a & b)
	['a', 'b'].forEach(char => {
		if (frm.fields_dict[`lebar_actual_${char}`]) {
			frm.fields_dict[`lebar_actual_${char}`].df.onchange = () => evaluate_category(frm, 'lebar', 2);
		}
	});

	// Triggers Berat (1 s/d 10)
	for (let i = 1; i <= 10; i++) {
		if (frm.fields_dict[`berat_actual_${i}`]) {
			frm.fields_dict[`berat_actual_${i}`].df.onchange = () => evaluate_category(frm, 'berat', 10);
		}
	}
}

// Helper 5: Kalkulasi Auto-Judge per kategori (Tebal, Lebar, Berat)
// Helper 7: Kalkulasi Auto-Judge per kategori (STRICT QA GATE: 0 ATAU BELUM DIISI = NG)
function evaluate_category(frm, category, total_samples, specs = null) {
	const min_val = specs ? parseFloat(specs[`${category}_grid_min`]) : parseFloat(frm.doc[`standar_${category}_min`]);
	const max_val = specs ? parseFloat(specs[`${category}_grid_max`]) : parseFloat(frm.doc[`standar_${category}_max`]);

	if (isNaN(min_val) || isNaN(max_val)) return;

	let is_ok = true;
	let has_input = false;

	for (let i = 1; i <= total_samples; i++) {
		let suffix = (category === 'lebar') ? (i === 1 ? 'a' : 'b') : i;
		let val = frm.doc[`${category}_actual_${suffix}`];

		// FIX: Kita hanya melewati field jika benar-benar kosong, undefined, atau null.
		// Jika bernilai 0 (belum diisi oleh operator), nilai 0 tersebut akan dievaluasi dan otomatis memicu NG!
		if (val !== undefined && val !== null && val !== "") {
			has_input = true;
			let num_val = parseFloat(val);
			
			// Jika ada 1 sampel saja di luar rentang toleransi Min-Max (termasuk nilai default 0)
			if (num_val < min_val || num_val > max_val) {
				is_ok = false;
				break; // Hentikan perulangan, vonis NG mutlak untuk kategori ini
			}
		}
	}

	const judge_field_name = `${category}_judge`; 
	if (frm.fields_dict[judge_field_name]) {
		if (has_input) {
			frm.set_value(judge_field_name, is_ok ? "OK" : "NG");
		} else {
			// Jika seluruh data kosong (tidak ada angka 0 sekalipun), kosongkan status
			frm.set_value(judge_field_name, "");
		}
		// Evaluasi keputusan akhir secara otomatis
		evaluate_final_judge(frm);
	}
}

// Helper 6: Keputusan Akhir Keseluruhan (Final Judge)
function evaluate_final_judge(frm) {
	const tebal = frm.doc.tebal_judge;
	const lebar = frm.doc.lebar_judge;
	const berat = frm.doc.berat_judge;
	
	if (tebal === "NG" || lebar === "NG" || berat === "NG") {
		frm.set_value('final_judge', 'NG');
	} else if ((tebal === "OK" || !tebal) && (lebar === "OK" || !lebar) && (berat === "OK" || !berat) && (tebal || lebar || berat)) {
		// Jika semua kategori yang memiliki isi berstatus OK, maka hasil akhir adalah OK
		frm.set_value('final_judge', 'OK');
	} else {
		// Jika seluruh data penilai kosong, kosongkan Final Judge
		frm.set_value('final_judge', '');
	}
}

function handle_field_permissions(frm) {
	// KECUALI: Administrator dan System Manager selalu bisa bypass/edit untuk penanganan darurat
	if (frappe.user.has_role("Administrator") || frappe.user.has_role("System Manager")) {
		set_section_read_only(frm, "form_permintaan_tab", false);
		set_section_read_only(frm, "form_pengecekan_tab", false);
		return;
	}

	const state = frm.doc.workflow_state;

	// KONDISI 1: Penguncian Tab Permintaan (Bagian A)
	if (!state || state === "Draft") {
		set_section_read_only(frm, "form_permintaan_tab", false); // Bisa diedit Teknisi
	} else {
		set_section_read_only(frm, "form_permintaan_tab", true); // Dikunci rapat setelah dikirim
	}

	// KONDISI 2: Penguncian Tab Pengecekan (Bagian B)
	if (state === "Menunggu Inspeksi") {
		// Hanya QC Inspector yang boleh edit Bagian B
		let is_inspector = frappe.user.has_role("QC Inspector");
		set_section_read_only(frm, "form_pengecekan_tab", !is_inspector);
	} 
	else if (state === "Menunggu Check") {
		// Hanya QC Leader yang boleh edit (koreksi) Bagian B
		let is_qc_leader = frappe.user.has_role("QC Leader");
		set_section_read_only(frm, "form_pengecekan_tab", !is_qc_leader);
	} 
	else {
		// Level Atasan (Supervisor QC & Prod), dokumen 100% Read-Only
		set_section_read_only(frm, "form_pengecekan_tab", true);
	}
}

// Helper 4: Pemindai Metadata untuk Mengunci Kolom secara Dinamis (No Hardcoding)
function set_section_read_only(frm, tab_fieldname, read_only) {
	let current_tab = null;
	frm.meta.fields.forEach(f => {
		if (f.fieldtype === "Tab Break") {
			current_tab = f.fieldname;
		}
		// Jika field berada di bawah tab target, dan bukan pembatas layout
		if (current_tab === tab_fieldname && f.fieldtype !== "Tab Break" && f.fieldtype !== "Column Break" && f.fieldtype !== "Section Break") {
			// Kecualikan field penilai otomatis (Judge) karena sifat dasarnya selalu read-only
			if (!f.fieldname.includes("judge") && f.fieldname !== "final_judge") {
				frm.set_df_property(f.fieldname, 'read_only', read_only ? 1 : 0);
			}
		}
	});
}

// Helper 8: Keputusan Akhir Keseluruhan (Final Judge)
