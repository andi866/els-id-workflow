/**
 * ELS.ID WORKFLOW SYSTEM
 * File : 20_GantiService.gs
 * Isi  : Permintaan ganti unit yang rusak saat aktivasi.
 *
 * Kejadiannya: Teknisi baru menemukan unit rusak saat mengaktifkan.
 * Barangnya sudah dibayar, notanya sudah terbit, dan yang perlu
 * diganti biasanya satu unit saja — bukan seluruh pesanan.
 *
 * Alurnya:
 *   Teknisi minta ganti  →  Gudang menyiapkan dan mengisi SN baru
 *                        →  Admin menerbitkan nota pengganti
 *                        →  Teknisi menerima dan menutup permintaan
 *
 * Tidak lewat Kasir, karena tidak ada uang yang berpindah.
 *
 * Permintaan disimpan di kolom override_flags pada transaksinya, jadi
 * tidak perlu sheet baru. Satu transaksi bisa punya beberapa permintaan
 * sekaligus — unit kedua bisa rusak setelah unit pertama diganti.
 */

// ============================================================
// BANTU
// ============================================================

function bacaGanti_(trx) {
  var f = {};
  try { f = JSON.parse(String(trx.override_flags || '') || '{}'); } catch (e) {}
  return (f.ganti && f.ganti.length) ? f.ganti : [];
}

function tulisGanti_(trx, daftar) {
  var f = {};
  try { f = JSON.parse(String(trx.override_flags || '') || '{}'); } catch (e) {}
  f.ganti = daftar;
  Repo.update(DB.SHEET.TRX, trx._row, { override_flags: JSON.stringify(f) });
  trx.override_flags = JSON.stringify(f);
}

function labelStatusGanti_(st) {
  return {
    MENUNGGU: 'Menunggu Gudang',
    SIAP: 'Unit pengganti siap',
    NOTA: 'Nota pengganti dibuat',
    INDENT: 'Menunggu barang datang',
    SELESAI: 'Selesai',
    BATAL: 'Dibatalkan'
  }[String(st)] || String(st);
}

function cariGanti_(trx, gantiId) {
  var daftar = bacaGanti_(trx);
  for (var i = 0; i < daftar.length; i++) {
    if (String(daftar[i].id) === String(gantiId)) return { i: i, g: daftar[i], daftar: daftar };
  }
  throw appErr_('NOT_FOUND', 'Permintaan ganti tidak ditemukan.');
}

/** Permintaan yang masih perlu ditangani seseorang */
function gantiTerbuka_(g) {
  return ['SELESAI', 'BATAL'].indexOf(String(g.status)) < 0;
}

// ============================================================
// TEKNISI — MEMINTA GANTI
// ============================================================

/** Nama divisi yang enak dibaca di kartu Gudang */
function labelDivisiGanti_(role) {
  return ({
    SALES: 'Sales',
    ADMIN: 'Admin',
    TEKNISI: 'Teknisi Support',
    SUPERADMIN: 'Super Admin',
    GUDANG: 'Gudang',
    KASIR: 'Kasir'
  })[String(role)] || String(role || '');
}

function apiMintaGanti(payload) {
  return withGuard_(payload, { lock: 'ringan' }, function (session) {
    /*
     * Admin juga boleh meminta ganti unit, bukan cuma Teknisi.
     *
     * Kerusakan tidak selalu ketahuan saat aktivasi. Sering unitnya
     * dicek Sales sambil Admin menyiapkan nota, dan baru di situ
     * ketahuan rusak — saat itu barangnya belum sampai meja Teknisi,
     * jadi Teknisi tidak punya apa pun untuk dimintakan ganti.
     *
     * Tanpa jalan ini, Admin terpaksa menghapus barangnya lalu
     * menambahkannya lagi. Hasilnya: SN lama tetap tercatat keluar
     * gudang, catatan Gudang tidak cocok dengan barang yang benar-
     * benar turun, dan tidak ada jejak kenapa unitnya berganti.
     */
    var boleh = hasPerm_(session, 'ACTIVATION_START') ||
                hasPerm_(session, 'NOTA_INPUT') ||
                hasPerm_(session, 'TRX_CONFIRM_SALES');
    if (!boleh) {
      throw appErr_('FORBIDDEN', 'Anda tidak punya akses untuk meminta ganti unit.');
    }

    var trx = Repo.findOne(DB.SHEET.TRX, 'trx_id', payload.trx_id);
    if (!trx) throw appErr_('NOT_FOUND', 'Transaksi tidak ditemukan.');
    if (Util.isTrue(trx.is_void)) throw appErr_('VOIDED', 'Transaksi ini sudah dibatalkan.');

    /*
     * Sales hanya untuk pesanannya sendiri.
     *
     * Sales-lah yang mengecek unit bersama customer, jadi dia yang
     * pertama tahu kalau ada yang rusak — tidak masuk akal kalau
     * harus menitip ke Admin untuk sesuatu yang dia lihat sendiri.
     *
     * Tapi akun Sales dipakai bergantian, jadi dibatasi pada pesanan
     * yang memang dia buat. Yang perlu menyentuh pesanan orang lain
     * tetap Admin.
     */
    if (!hasPerm_(session, 'ACTIVATION_START') &&
        !hasPerm_(session, 'NOTA_INPUT') &&
        String(trx.sales_user_id) !== String(session.user_id)) {
      throw appErr_('FORBIDDEN',
        'Pesanan ini bukan Anda yang buat. Minta Admin yang mengajukan gantinya.');
    }

    var tahap = String(trx.stage_status);
    if (['DRAFT', 'MENUNGGU_GUDANG', 'PROSES_GUDANG'].indexOf(tahap) >= 0) {
      throw appErr_('STAGE_LOCKED',
        'Barangnya masih di Gudang dan belum disiapkan. Minta Gudang menukar ' +
        'unitnya langsung, tidak perlu lewat permintaan ganti.');
    }

    var it = Repo.findOne(DB.SHEET.ITEMS, 'item_id', payload.item_id);
    if (!it || String(it.trx_id) !== String(trx.trx_id)) {
      throw appErr_('NOT_FOUND', 'Barang tidak ditemukan di pesanan ini.');
    }

    var alasan = String(payload.alasan || '').trim();
    if (alasan.length < 4) {
      throw appErr_('NO_REASON',
        'Isi dulu apa yang rusak. Keterangan ini yang dibaca Gudang saat menyiapkan penggantinya.');
    }

    var unit = Number(payload.unit_seq) || 1;
    var qty = Number(it.qty) || 1;
    if (unit < 1 || unit > qty) unit = 1;

    // SN unit yang rusak, supaya Gudang tahu unit mana yang ditarik
    var snLama = '';
    try {
      Repo.findManyFast(DB.SHEET.SN, 'item_id', it.item_id).forEach(function (x) {
        if (!Util.isTrue(x.is_active)) return;
        if (Number(x.unit_seq) === unit) snLama = String(x.serial_number);
      });
    } catch (e) {}

    var daftar = bacaGanti_(trx);

    // Satu unit tidak boleh punya dua permintaan terbuka sekaligus
    var bentrok = daftar.filter(function (g) {
      return gantiTerbuka_(g) && String(g.item_id) === String(it.item_id) &&
             Number(g.unit_seq) === unit;
    })[0];
    if (bentrok) {
      throw appErr_('ALREADY',
        'Unit ini sudah punya permintaan ganti yang belum selesai (' +
        labelStatusGanti_(bentrok.status) + ').');
    }

    var g = {
      id: Util.id('GNT'),
      item_id: String(it.item_id),
      product_code: String(it.product_code),
      product_name: String(it.product_name),
      unit_seq: unit,
      sn_lama: snLama,
      sn_baru: '',
      alasan: alasan.substring(0, 250),
      status: 'MENUNGGU',
      minta_by: session.full_name,
      minta_role: String(session.role),

      /*
       * Unit penggantinya diserahkan ke siapa.
       *
       * Dulu alur ini hanya dipakai Teknisi, jadi Gudang tahu sendiri
       * barangnya mau dibawa ke mana. Sekarang Sales dan Admin juga
       * bisa memintanya — dan tanpa keterangan ini, Gudang menyiapkan
       * unit lalu bingung mau diserahkan ke siapa, atau salah kirim
       * ke meja yang tidak menunggunya.
       *
       * Yang dicatat nama orangnya, bukan sekadar divisinya, supaya
       * jelas siapa yang harus ditemui.
       */
      serahkan_ke: session.full_name,
      serahkan_divisi: labelDivisiGanti_(session.role),

      minta_at: nowIso_()
    };

    daftar.push(g);
    tulisGanti_(trx, daftar);

    logAudit_(session, {
      entity: 'ITEM', entity_id: it.item_id, trx_no: trx.trx_no,
      action: 'CREATE', field: 'minta_ganti',
      new_value: it.product_name + ' unit ' + unit + (snLama ? ' · SN ' + snLama : ''),
      reason: alasan
    });
    logTimeline_(session, {
      trx_id: trx.trx_id, trx_no: trx.trx_no,
      event_code: 'MINTA_GANTI', stage_after: String(trx.stage_status),
      event_label: 'Teknisi ' + session.full_name + ' minta ganti unit rusak',
      detail: it.product_name + ' unit ' + unit + ' · ' + alasan
    });

    var isi = trx.trx_no + ' · ' + trx.cust_name_snap + ' · ' +
              it.product_name + ' unit ' + unit +
              (snLama ? ' (SN ' + snLama + ')' : '') + ' · ' + alasan;

    pushNotif_({
      target_role: peranPenyiap_(trx), target_branch: trx.branch,
      trx_id: trx.trx_id, trx_no: trx.trx_no,
      type: 'GANTI_UNIT', priority: 'HIGH',
      title: 'Minta ganti unit rusak', body: isi
    });

    // Admin diberi tahu sejak awal, supaya bisa menyiapkan notanya
    // sambil menunggu Gudang mengisi SN
    pushNotif_({
      target_role: 'ADMIN', target_branch: trx.branch,
      trx_id: trx.trx_id, trx_no: trx.trx_no,
      type: 'GANTI_UNIT', priority: 'NORMAL',
      title: 'Ada permintaan ganti unit', body: isi
    });

    return { ganti_id: g.id, pesan: 'Gudang sudah diberi tahu.' };
  });
}

// ============================================================
// GUDANG — MENYIAPKAN PENGGANTI
// ============================================================

function apiGantiSiap(payload) {
  return withGuard_(payload, { permission: 'SN_INPUT', lock: true }, function (session) {
    var trx = Repo.findOne(DB.SHEET.TRX, 'trx_id', payload.trx_id);
    if (!trx) throw appErr_('NOT_FOUND', 'Transaksi tidak ditemukan.');

    var k = cariGanti_(trx, payload.ganti_id);
    var g = k.g;

    if (['MENUNGGU', 'INDENT'].indexOf(String(g.status)) < 0) {
      throw appErr_('STAGE_LOCKED',
        'Permintaan ini sudah pada tahap "' + labelStatusGanti_(g.status) + '".');
    }

    var snBaru = String(payload.sn_baru || '').trim().toUpperCase();
    var it = Repo.findOne(DB.SHEET.ITEMS, 'item_id', g.item_id);
    if (!it) throw appErr_('NOT_FOUND', 'Barang tidak ditemukan.');

    /*
     * SN baru diperiksa dulu terhadap seluruh transaksi lain.
     *
     * Unit pengganti diambil dari stok, jadi SN-nya bisa saja sudah
     * pernah tercatat keluar untuk transaksi lain — dan itu berarti
     * unitnya salah ambil.
     */
    if (snBaru) {
      var dipakai = null;
      Repo.columns(DB.SHEET.SN, ['sn_id', 'trx_no', 'serial_number', 'is_active'])
        .forEach(function (x) {
          if (!Util.isTrue(x.is_active)) return;
          if (String(x.serial_number).trim().toUpperCase() !== snBaru) return;
          if (String(x.trx_no) === String(trx.trx_no)) return;
          dipakai = String(x.trx_no);
        });
      if (dipakai) {
        throw appErr_('SN_USED',
          'SN "' + snBaru + '" sudah tercatat keluar untuk transaksi ' + dipakai + '. ' +
          'Cek lagi unit yang diambil.');
      }

      // Unit lama dinonaktifkan, unit baru menggantikan nomornya
      try {
        Repo.findManyFast(DB.SHEET.SN, 'item_id', g.item_id).forEach(function (x) {
          if (!Util.isTrue(x.is_active)) return;
          if (Number(x.unit_seq) !== Number(g.unit_seq)) return;
          Repo.update(DB.SHEET.SN, x._row, {
            is_active: false,
            void_reason: 'Unit rusak, diganti: ' + g.alasan
          });
        });
      } catch (e) {}

      Repo.append(DB.SHEET.SN, {
        sn_id: Util.id('SN'), trx_id: trx.trx_id, trx_no: trx.trx_no,
        item_id: g.item_id, product_code: g.product_code,
        unit_seq: Number(g.unit_seq), serial_number: snBaru,
        input_by: session.user_id, input_at: nowIso_(),
        is_active: true, void_reason: ''
      });

      bustSnHistCache_();
    }

    /*
     * Nota pengganti hanya perlu kalau notanya memang sudah terbit.
     *
     * Kalau kerusakan ketahuan sebelum Admin membuat nota — biasanya
     * saat Sales mengecek unit yang baru turun — maka tidak ada nota
     * yang perlu diganti. SN-nya saja yang berubah, dan notanya nanti
     * langsung terbit dengan SN yang benar.
     *
     * Memaksa Admin menerbitkan nota pengganti untuk nota yang belum
     * ada cuma menambah pekerjaan dan membingungkan: nomor pengganti
     * untuk nomor yang tidak pernah dipakai.
     */
    var sudahBernota = !!String(trx.nota_no || '').trim();

    k.daftar[k.i].sn_baru = snBaru;
    k.daftar[k.i].status = sudahBernota ? 'SIAP' : 'SELESAI';
    k.daftar[k.i].gudang_by = session.full_name;
    k.daftar[k.i].gudang_at = nowIso_();

    if (!sudahBernota) {
      k.daftar[k.i].selesai_by = 'Sistem';
      k.daftar[k.i].selesai_at = nowIso_();
      k.daftar[k.i].catatan_tutup =
        'Selesai tanpa nota pengganti — notanya memang belum terbit saat unit diganti';
    }

    tulisGanti_(trx, k.daftar);

    logAudit_(session, {
      entity: 'SN', entity_id: g.item_id, trx_no: trx.trx_no,
      action: 'OVERRIDE', field: 'ganti_unit',
      old_value: g.sn_lama || '(tanpa SN)', new_value: snBaru || '(tanpa SN)',
      reason: 'Unit rusak diganti: ' + g.alasan
    });
    logTimeline_(session, {
      trx_id: trx.trx_id, trx_no: trx.trx_no,
      event_code: 'GANTI_SIAP', stage_after: String(trx.stage_status),
      event_label: 'Gudang ' + session.full_name + ' menyiapkan unit pengganti',
      detail: g.product_name + ' unit ' + g.unit_seq +
        (snBaru ? ' · SN baru ' + snBaru : '') +
        (g.sn_lama ? ' · menggantikan ' + g.sn_lama : '')
    });

    var isi = trx.trx_no + ' · ' + g.product_name + ' unit ' + g.unit_seq +
              (snBaru ? ' · SN baru ' + snBaru : '');

    if (!sudahBernota) {
      // Yang perlu tahu: yang memintanya, supaya unitnya dicek lagi
      pushNotif_({
        target_role: String(g.minta_role || 'SALES'), target_branch: trx.branch,
        trx_id: trx.trx_id, trx_no: trx.trx_no,
        type: 'GANTI_UNIT', priority: 'HIGH',
        title: 'Unit pengganti sudah siap',
        body: isi + ' · ambil di Gudang. Notanya belum terbit, jadi tidak perlu ' +
              'nota pengganti.'
      });

      flushLog_();
      return {
        ok: true,
        pesan: 'Unit pengganti dicatat. Notanya belum terbit, jadi tidak perlu ' +
               'nota pengganti — Admin akan menerbitkan nota dengan SN yang baru.'
      };
    }

    pushNotif_({
      target_role: 'ADMIN', target_branch: trx.branch,
      trx_id: trx.trx_id, trx_no: trx.trx_no,
      type: 'GANTI_UNIT', priority: 'HIGH',
      title: 'Unit pengganti siap — buat nota pengganti', body: isi
    });
    pushNotif_({
      target_role: 'TEKNISI', target_branch: trx.branch,
      trx_id: trx.trx_id, trx_no: trx.trx_no,
      type: 'GANTI_UNIT', priority: 'NORMAL',
      title: 'Unit pengganti sudah disiapkan', body: isi
    });

    return { ok: true, pesan: 'Unit pengganti ditandai siap. Admin sudah diberi tahu.' };
  });
}

/** Tipe penggantinya kosong — permintaan menunggu barang datang */
function apiGantiIndent(payload) {
  return withGuard_(payload, { permission: 'SN_INPUT', lock: 'ringan' }, function (session) {
    var trx = Repo.findOne(DB.SHEET.TRX, 'trx_id', payload.trx_id);
    if (!trx) throw appErr_('NOT_FOUND', 'Transaksi tidak ditemukan.');

    var k = cariGanti_(trx, payload.ganti_id);
    var catatan = String(payload.catatan || '').trim();

    k.daftar[k.i].status = 'INDENT';
    k.daftar[k.i].indent_note = catatan.substring(0, 250);
    k.daftar[k.i].indent_by = session.full_name;
    k.daftar[k.i].indent_at = nowIso_();
    tulisGanti_(trx, k.daftar);

    logTimeline_(session, {
      trx_id: trx.trx_id, trx_no: trx.trx_no,
      event_code: 'GANTI_INDENT', stage_after: String(trx.stage_status),
      event_label: session.full_name + ' menandai unit pengganti harus diindent',
      detail: k.g.product_name + ' unit ' + k.g.unit_seq +
        (catatan ? ' · ' + catatan : '')
    });

    var isi = trx.trx_no + ' · ' + k.g.product_name + ' unit ' + k.g.unit_seq +
              ' · stok kosong' + (catatan ? ' · ' + catatan : '');

    ['ADMIN', 'TEKNISI', 'SALES'].forEach(function (r) {
      pushNotif_({
        target_role: r, target_branch: trx.branch,
        trx_id: trx.trx_id, trx_no: trx.trx_no,
        type: 'GANTI_UNIT', priority: 'NORMAL',
        title: 'Unit pengganti harus diindent', body: isi
      });
    });

    return { ok: true, pesan: 'Ditandai menunggu barang datang.' };
  });
}

// ============================================================
// ADMIN — NOTA PENGGANTI
// ============================================================

function apiGantiNota(payload) {
  return withGuard_(payload, { permission: 'NOTA_INPUT', lock: true }, function (session) {
    var trx = Repo.findOne(DB.SHEET.TRX, 'trx_id', payload.trx_id);
    if (!trx) throw appErr_('NOT_FOUND', 'Transaksi tidak ditemukan.');

    var k = cariGanti_(trx, payload.ganti_id);
    var nota = String(payload.nota_ganti || '').trim();
    if (nota.length < 3) throw appErr_('BAD_NOTA', 'Nomor nota pengganti belum diisi.');

    k.daftar[k.i].nota_ganti = nota;
    k.daftar[k.i].nota_by = session.full_name;
    k.daftar[k.i].nota_at = nowIso_();
    if (String(k.g.status) === 'SIAP') k.daftar[k.i].status = 'NOTA';
    tulisGanti_(trx, k.daftar);

    logAudit_(session, {
      entity: 'TRX', entity_id: trx.trx_id, trx_no: trx.trx_no,
      action: 'CREATE', field: 'nota_ganti',
      new_value: nota + ' · ' + k.g.product_name + ' unit ' + k.g.unit_seq
    });
    logTimeline_(session, {
      trx_id: trx.trx_id, trx_no: trx.trx_no,
      event_code: 'GANTI_NOTA', stage_after: String(trx.stage_status),
      event_label: 'Admin ' + session.full_name + ' membuat nota pengganti',
      detail: nota + ' · ' + k.g.product_name + ' unit ' + k.g.unit_seq
    });

    pushNotif_({
      target_role: 'TEKNISI', target_branch: trx.branch,
      trx_id: trx.trx_id, trx_no: trx.trx_no,
      type: 'GANTI_UNIT', priority: 'HIGH',
      title: 'Nota pengganti siap diambil',
      body: trx.trx_no + ' · ' + nota + ' · ' + k.g.product_name + ' unit ' + k.g.unit_seq
    });

    return { ok: true };
  });
}

// ============================================================
// TEKNISI — MENUTUP PERMINTAAN
// ============================================================

function apiGantiSelesai(payload) {
  return withGuard_(payload, { permission: 'ACTIVATION_DONE', lock: 'ringan' }, function (session) {
    var trx = Repo.findOne(DB.SHEET.TRX, 'trx_id', payload.trx_id);
    if (!trx) throw appErr_('NOT_FOUND', 'Transaksi tidak ditemukan.');

    var k = cariGanti_(trx, payload.ganti_id);
    if (['SIAP', 'NOTA'].indexOf(String(k.g.status)) < 0) {
      throw appErr_('STAGE_LOCKED',
        'Unit penggantinya belum siap. Status sekarang: ' + labelStatusGanti_(k.g.status) + '.');
    }

    k.daftar[k.i].status = 'SELESAI';
    k.daftar[k.i].selesai_by = session.full_name;
    k.daftar[k.i].selesai_at = nowIso_();
    tulisGanti_(trx, k.daftar);

    logTimeline_(session, {
      trx_id: trx.trx_id, trx_no: trx.trx_no,
      event_code: 'GANTI_SELESAI', stage_after: String(trx.stage_status),
      event_label: 'Teknisi ' + session.full_name + ' menerima unit pengganti',
      detail: k.g.product_name + ' unit ' + k.g.unit_seq +
        (k.g.sn_baru ? ' · SN ' + k.g.sn_baru : '')
    });

    return { ok: true };
  });
}

function apiGantiBatal(payload) {
  return withGuard_(payload, { permission: 'ACTIVATION_START', lock: 'ringan' }, function (session) {
    var trx = Repo.findOne(DB.SHEET.TRX, 'trx_id', payload.trx_id);
    if (!trx) throw appErr_('NOT_FOUND', 'Transaksi tidak ditemukan.');

    var k = cariGanti_(trx, payload.ganti_id);
    var alasan = String(payload.reason || '').trim();
    if (alasan.length < 4) throw appErr_('NO_REASON', 'Isi alasannya dulu.');

    k.daftar[k.i].status = 'BATAL';
    k.daftar[k.i].batal_by = session.full_name;
    k.daftar[k.i].batal_at = nowIso_();
    k.daftar[k.i].batal_alasan = alasan.substring(0, 250);
    tulisGanti_(trx, k.daftar);

    logTimeline_(session, {
      trx_id: trx.trx_id, trx_no: trx.trx_no,
      event_code: 'GANTI_BATAL', stage_after: String(trx.stage_status),
      event_label: session.full_name + ' membatalkan permintaan ganti unit',
      detail: k.g.product_name + ' unit ' + k.g.unit_seq + ' · ' + alasan
    });

    pushNotif_({
      target_role: peranPenyiap_(trx), target_branch: trx.branch,
      trx_id: trx.trx_id, trx_no: trx.trx_no,
      type: 'GANTI_UNIT', priority: 'NORMAL',
      title: 'Permintaan ganti dibatalkan',
      body: trx.trx_no + ' · ' + k.g.product_name + ' unit ' + k.g.unit_seq + ' · ' + alasan
    });

    return { ok: true };
  });
}

// ============================================================
// DAFTAR PERMINTAAN
// ============================================================

function apiGantiList(payload) {
  return withGuard_(payload, {}, function (session) {
    var semuaCabang = hasPerm_(session, 'TRX_VIEW_ALL');
    var tampilkanSelesai = Util.isTrue(payload.semua);
    var sekarang = new Date().getTime();

    var rows = Repo.columns(DB.SHEET.TRX, [
      'trx_id', 'trx_no', 'branch', 'cust_name_snap', 'cust_phone_snap',
      'sales_name', 'stage_status', 'nota_no', 'override_flags', 'is_void'
    ]);

    var out = [];

    rows.forEach(function (t) {
      if (Util.isTrue(t.is_void)) return;
      if (!semuaCabang && String(t.branch) !== String(session.branch)) return;
      if (String(t.override_flags || '').indexOf('"ganti"') < 0) return;

      var daftar = bacaGanti_(t);
      daftar.forEach(function (g) {
        if (!tampilkanSelesai && !gantiTerbuka_(g)) return;

        var menit = 0;
        if (g.minta_at) {
          menit = Math.max(Math.round((sekarang - new Date(g.minta_at).getTime()) / 60000), 0);
        }

        out.push({
          trx_id: String(t.trx_id), trx_no: String(t.trx_no),
          cust_name: String(t.cust_name_snap), cust_phone: String(t.cust_phone_snap),
          sales_name: String(t.sales_name || ''), nota_no: String(t.nota_no || ''),
          stage_label: stageLabel_(t.stage_status),
          id: String(g.id), item_id: String(g.item_id),
          product_name: String(g.product_name), product_code: String(g.product_code),
          unit_seq: Number(g.unit_seq) || 1,
          sn_lama: String(g.sn_lama || ''), sn_baru: String(g.sn_baru || ''),
          alasan: String(g.alasan || ''),
          status: String(g.status), status_label: labelStatusGanti_(g.status),
          indent_note: String(g.indent_note || ''),
          nota_ganti: String(g.nota_ganti || ''),
          minta_by: String(g.minta_by || ''), minta_at: String(g.minta_at || ''),
          serahkan_ke: String(g.serahkan_ke || g.minta_by || ''),
          serahkan_divisi: String(g.serahkan_divisi || labelDivisiGanti_(g.minta_role)),
          gudang_by: String(g.gudang_by || ''),
          menit: menit
        });
      });
    });

    out.sort(function (a, b) { return b.menit - a.menit; });

    return {
      list: out,
      total: out.length,
      menunggu: out.filter(function (x) { return x.status === 'MENUNGGU'; }).length,
      siap: out.filter(function (x) { return x.status === 'SIAP' || x.status === 'NOTA'; }).length,
      indent: out.filter(function (x) { return x.status === 'INDENT'; }).length
    };
  });
}

/** Dipakai layar Gudang untuk membunyikan alarm */
function hitungGantiTerbuka_(session) {
  var n = 0;
  try {
    var semuaCabang = hasPerm_(session, 'TRX_VIEW_ALL');
    Repo.columns(DB.SHEET.TRX, ['trx_id', 'branch', 'override_flags', 'is_void'])
      .forEach(function (t) {
        if (Util.isTrue(t.is_void)) return;
        if (!semuaCabang && String(t.branch) !== String(session.branch)) return;
        if (String(t.override_flags || '').indexOf('"ganti"') < 0) return;
        bacaGanti_(t).forEach(function (g) {
          if (String(g.status) === 'MENUNGGU') n++;
        });
      });
  } catch (e) {}
  return n;
}

/**
 * Menutup permintaan ganti oleh Gudang atau Admin.
 *
 * Teknisi kadang lupa menekan "Sudah diterima" — barangnya sudah di
 * tangan customer, tapi permintaannya tetap berdiri di daftar Gudang
 * seolah masih ada yang harus dikerjakan.
 *
 * Yang menyiapkan barangnya juga tahu kalau sudah diserahkan, jadi
 * tidak masuk akal kalau hanya Teknisi yang bisa menutupnya.
 */
function apiGantiTutup(payload) {
  return withGuard_(payload, { permission: 'SN_INPUT', lock: 'ringan' }, function (session) {
    var trx = Repo.findOne(DB.SHEET.TRX, 'trx_id', payload.trx_id);
    if (!trx) throw appErr_('NOT_FOUND', 'Transaksi tidak ditemukan.');

    var k = cariGanti_(trx, payload.ganti_id);
    if (!gantiTerbuka_(k.g)) {
      throw appErr_('ALREADY', 'Permintaan ini sudah ditutup.');
    }

    k.daftar[k.i].status = 'SELESAI';
    k.daftar[k.i].selesai_by = session.full_name;
    k.daftar[k.i].selesai_at = nowIso_();
    k.daftar[k.i].catatan_tutup = String(payload.catatan || '').substring(0, 200);
    tulisGanti_(trx, k.daftar);

    logTimeline_(session, {
      trx_id: trx.trx_id, trx_no: trx.trx_no,
      event_code: 'GANTI_SELESAI', stage_after: String(trx.stage_status),
      event_label: session.full_name + ' menutup permintaan ganti unit',
      detail: k.g.product_name + ' unit ' + k.g.unit_seq +
        (payload.catatan ? ' · ' + payload.catatan : '')
    });

    return { ok: true };
  });
}

/**
 * Menutup semua permintaan ganti yang masih terbuka pada satu transaksi.
 *
 * Dipanggil saat barangnya ditandai sudah diserahkan ke customer.
 * Kalau barangnya sudah keluar, tidak mungkin masih ada unit pengganti
 * yang ditunggu — jadi tidak perlu menunggu ada yang ingat menutupnya.
 */
function tutupGantiOtomatis_(session, trx) {
  try {
    var daftar = bacaGanti_(trx);
    if (!daftar.length) return 0;

    var n = 0;
    daftar.forEach(function (g, i) {
      if (!gantiTerbuka_(g)) return;
      daftar[i].status = 'SELESAI';
      daftar[i].selesai_by = session.full_name;
      daftar[i].selesai_at = nowIso_();
      daftar[i].catatan_tutup = 'Ditutup sendiri saat barang diserahkan';
      n++;
    });

    if (n) tulisGanti_(trx, daftar);
    return n;
  } catch (e) { return 0; }
}

/**
 * Data untuk mencetak Form Unit Rusak.
 *
 * Gunanya menempel di unit yang ditarik. Tanpa penanda fisik, unit
 * rusak yang sudah diturunkan gampang tercampur lagi dengan stok
 * bagus — dan baru ketahuan saat terjual ke customer berikutnya.
 */
function apiFormRusak(payload) {
  return withGuard_(payload, {}, function (session) {
    var trx = Repo.findOne(DB.SHEET.TRX, 'trx_id', payload.trx_id);
    if (!trx) throw appErr_('NOT_FOUND', 'Transaksi tidak ditemukan.');

    var boleh = hasPerm_(session, 'NOTA_INPUT') ||
                hasPerm_(session, 'ACTIVATION_START') ||
                hasPerm_(session, 'SN_INPUT') ||
                String(trx.sales_user_id) === String(session.user_id);
    if (!boleh) throw appErr_('FORBIDDEN', 'Anda tidak punya akses ke pesanan ini.');

    var daftar = bacaGanti_(trx);
    var g = null;

    if (payload.ganti_id) {
      daftar.forEach(function (x) { if (String(x.id) === String(payload.ganti_id)) g = x; });
    } else {
      // Yang terbaru kalau tidak disebut
      daftar.forEach(function (x) { g = x; });
    }
    if (!g) throw appErr_('NOT_FOUND', 'Permintaan ganti tidak ditemukan.');

    return {
      trx_no: String(trx.trx_no),
      trx_date: Util.dateStr(trx.trx_date),
      cust_name: String(trx.cust_name_snap),
      cust_phone: String(trx.cust_phone_snap),
      nota_no: String(trx.nota_no || trx.nota_indent || ''),
      sales_name: String(trx.sales_name || ''),
      sales_code: String(trx.sales_code || ''),
      cabang: String(trx.branch),

      product_name: String(g.product_name || ''),
      product_code: String(g.product_code || ''),
      unit_seq: Number(g.unit_seq) || 1,
      sn_rusak: String(g.sn_rusak || g.sn_lama || ''),
      sn_baru: String(g.sn_baru || ''),
      keluhan: String(g.keluhan || g.alasan || ''),

      minta_by: String(g.minta_by || ''),
      minta_at: String(g.minta_at || ''),
      serahkan_ke: String(g.serahkan_ke || g.minta_by || ''),
      serahkan_divisi: String(g.serahkan_divisi || labelDivisiGanti_(g.minta_role)),
      gudang_by: String(g.gudang_by || ''),
      status: String(g.status || ''),
      status_label: labelStatusGanti_(g.status),

      dicetak_oleh: session.full_name,
      dicetak_at: nowIso_(),
      perusahaan: Settings.get('COMPANY_NAME', 'ELS.ID Purwokerto')
    };
  });
}
