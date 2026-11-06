/**
 * ELS.ID WORKFLOW SYSTEM — Phase 5
 * File : 09_AdminService.gs
 * Isi  : Monitoring seluruh transaksi, persetujuan harga,
 *        cetak resep, dan penomoran nota.
 *
 * Aturan yang dipegang file ini:
 * - Resep hanya bisa dicetak setelah Gudang konfirmasi.
 * - Nomor nota tidak bisa dibuat selama masih ada harga yang
 *   menunggu persetujuan.
 * - Nomor nota tidak boleh kembar.
 * - Data resep selalu diambil ulang dari database saat tombol
 *   ditekan, bukan dari layar yang mungkin sudah lama dibuka.
 *
 * Catatan: status persetujuan harga disimpan di kolom override_flags
 * pada sheet TRANSACTIONS, jadi tidak perlu kolom baru.
 */

// ============================================================
// PERSETUJUAN HARGA
// ============================================================

function bacaOverride_(trx) {
  var teks = String(trx.override_flags || '').trim();
  if (!teks) return {};
  try { return JSON.parse(teks); } catch (e) { return {}; }
}

function tulisOverride_(trx, obj) {
  Repo.update(DB.SHEET.TRX, trx._row, { override_flags: JSON.stringify(obj) });
}

/**
 * Barang yang diskonnya melewati batas dan belum disetujui,
 * atau sudah disetujui tapi harganya diubah lagi setelah itu.
 */
function cekApproval_(trx, items) {
  var batas = Settings.num('MAX_DISCOUNT_PCT_SALES', 5);
  var over = bacaOverride_(trx);
  var setuju = over.approvals || {};

  var hasil = [];
  items.forEach(function (i) {
    /*
     * Persetujuan tetap diukur dari harga KATALOG, bukan harga jual.
     *
     * Kalau diukur dari harga jual, Sales bisa menaikkan harga dulu lalu
     * memberi diskon besar — di atas kertas diskonnya kecil, padahal
     * harga akhirnya tetap di bawah katalog.
     */
    var mp = Number(i.master_price) || 0;
    var up = Number(i.unit_price) || 0;
    var pct = mp > 0 ? ((mp - up) / mp) * 100 : 0;
    if (pct <= batas + 0.001) return;

    var rekam = setuju[String(i.item_id)];
    var disetujui = !!(rekam && Number(rekam.price) === up);

    hasil.push({
      item_id: String(i.item_id),
      product_name: String(i.product_name),
      product_code: String(i.product_code),
      qty: Number(i.qty) || 0,
      master_price: mp, unit_price: up,
      disc_pct: Math.round(pct * 10) / 10,
      disetujui: disetujui,
      approved_by: disetujui ? String(rekam.name || '') : '',
      approved_at: disetujui ? String(rekam.at || '') : '',
      // Pernah disetujui tapi harganya diubah lagi setelah itu
      basi: !!(rekam && Number(rekam.price) !== up)
    });
  });
  return hasil;
}

function apiApprovePrice(payload) {
  return withGuard_(payload, { permission: 'PRICE_APPROVE', lock: true }, function (session) {
    var trx = Repo.findOne(DB.SHEET.TRX, 'trx_id', payload.trx_id);
    if (!trx) throw appErr_('NOT_FOUND', 'Transaksi tidak ditemukan.');

    var it = Repo.findOne(DB.SHEET.ITEMS, 'item_id', payload.item_id);
    if (!it || String(it.trx_id) !== String(trx.trx_id)) {
      throw appErr_('NOT_FOUND', 'Barang tidak ditemukan di pesanan ini.');
    }

    var over = bacaOverride_(trx);
    if (!over.approvals) over.approvals = {};

    var harga = Number(it.unit_price) || 0;
    var mp = Number(it.master_price) || 0;
    var pct = mp > 0 ? Math.round(((mp - harga) / mp) * 1000) / 10 : 0;

    if (Util.isTrue(payload.setuju)) {
      over.approvals[String(it.item_id)] = {
        by: session.user_id, name: session.full_name,
        at: nowIso_(), price: harga, pct: pct,
        reason: String(payload.reason || '')
      };
      logAudit_(session, {
        entity: 'ITEM', entity_id: it.item_id, trx_no: trx.trx_no,
        action: 'OVERRIDE', field: 'price_approval',
        old_value: 'menunggu', new_value: 'disetujui @' + harga + ' (diskon ' + pct + '%)',
        reason: payload.reason || ''
      });
      logTimeline_(session, {
        trx_id: trx.trx_id, trx_no: trx.trx_no,
        event_code: 'PRICE_APPROVED', stage_after: String(trx.stage_status),
        event_label: 'Admin ' + session.full_name + ' menyetujui harga ' + it.product_name,
        detail: 'Diskon ' + pct + '% · ' + formatRp_(harga)
      });
    } else {
      delete over.approvals[String(it.item_id)];
      logAudit_(session, {
        entity: 'ITEM', entity_id: it.item_id, trx_no: trx.trx_no,
        action: 'OVERRIDE', field: 'price_approval',
        old_value: 'disetujui', new_value: 'ditolak',
        reason: payload.reason || ''
      });
    }

    tulisOverride_(trx, over);
    /*
     * Tidak membaca ulang seluruh transaksi.
     *
     * Setelah nota tersimpan, layar Admin langsung berpindah ke daftar.
     * Membaca ulang barang, serial number, pembayaran, dan riwayat
     * hanya untuk dikirim ke layar yang sudah ditinggalkan adalah
     * ongkos satu sampai dua detik yang dibayar tanpa ada yang
     * memakainya.
     */
    jam.tandai('simpan & beri tahu');
    jam.selesai();

    return {
      ringkas: true,
      trx_no: String(trx.trx_no),
      nota_no: nota,
      stage: patch.stage_status || String(trx.stage_status),
      lunas: String(trx.payment_status) === 'LUNAS'
    };
  });
}

// ============================================================
// MONITORING
// ============================================================

function apiAdminList(payload) {
  return withGuard_(payload, { permission: 'TRX_VIEW_ALL' }, function (session) {
    var scope = String(payload.scope || 'aktif');
    var q = String(payload.q || '').trim().toUpperCase();
    var hari = Number(payload.hari === undefined ? 7 : payload.hari);
    var today = Util.todayStr();

    var batas = new Date();
    batas.setDate(batas.getDate() - hari);
    var batasStr = Utilities.formatDate(batas, 'Asia/Jakarta', 'yyyy-MM-dd');

    var rows = Repo.columns(DB.SHEET.TRX, [
      'trx_id', 'trx_no', 'branch', 'trx_date', 'cust_name_snap', 'cust_phone_snap',
      'sales_name', 'sales_code', 'stage_status', 'payment_status',
      'item_count', 'grand_total', 'paid_total', 'outstanding',
      'nota_no', 'nota_indent', 'sales_confirm_at', 'gudang_confirm_at', 'updated_at',
      'override_flags', 'is_void'
    ]);

    var sekarang = new Date().getTime();
    var batasDiam = Settings.num('STUCK_ALERT_MIN', 30);
    var out = [], hitung = {};

    for (var i = 0; i < rows.length; i++) {
      var t = rows[i];
      if (Util.isTrue(t.is_void)) continue;

      var tgl = Util.dateStr(t.trx_date);
      if (hari > 0 && tgl < batasStr) continue;

      var stage = String(t.stage_status);
      hitung[stage] = (hitung[stage] || 0) + 1;

      if (scope === 'hari_ini' && tgl !== today) continue;
      if (scope === 'aktif' && ['SELESAI', 'DIBATALKAN'].indexOf(stage) >= 0) continue;
      // Indent yang belum punya NOTA PESANAN juga perlu diurus Admin
      if (scope === 'siap_nota' &&
          !(stage === 'SIAP_NOTA' ||
            (stage === 'MENUNGGU_BARANG' && !String(t.nota_indent || '').trim()))) continue;
      if (scope === 'belum_lunas' && String(t.payment_status) === 'LUNAS') continue;

      if (q) {
        var bahan = [t.trx_no, t.cust_name_snap, t.cust_phone_snap,
                     t.sales_name, t.sales_code, t.nota_no].join(' ').toUpperCase();
        if (bahan.indexOf(q) < 0) continue;
      }

      var acuan = t.gudang_confirm_at || t.sales_confirm_at;
      var menit = acuan ? Math.round((sekarang - new Date(Util.isoStr(acuan)).getTime()) / 60000) : 0;

      out.push({
        trx_id: String(t.trx_id), trx_no: String(t.trx_no || '(belum bernomor)'),
        branch: String(t.branch),
        cust_name: String(t.cust_name_snap), cust_phone: Util.hp(t.cust_phone_snap),
        sales_name: String(t.sales_name || ''), sales_code: String(t.sales_code || ''),
        stage_status: stage, stage_label: stageLabel_(stage),
        payment_status: String(t.payment_status),
        item_count: Number(t.item_count) || 0,
        grand_total: Number(t.grand_total) || 0,
        outstanding: Number(t.outstanding) || 0,
        nota_no: String(t.nota_no || ''),
        nota_indent: String(t.nota_indent || ''),
        trx_date: tgl,
        updated_at: Util.isoStr(t.updated_at),
        menit: menit,
        tertahan: ['SIAP_NOTA', 'MENUNGGU_GUDANG', 'PROSES_GUDANG'].indexOf(stage) >= 0 &&
                  menit >= batasDiam
      });
    }

    out.sort(function (a, b) { return a.updated_at < b.updated_at ? 1 : -1; });

    return {
      list: out.slice(0, 150),
      total: out.length,
      hitung: hitung,
      stuckMin: batasDiam
    };
  });
}

// ============================================================
// DETAIL TRANSAKSI
// ============================================================

function apiAdminDetailData_(session, trxId, payload_riwayat) {
  var state = buildTrxState_(session, trxId);
  var trx = Repo.findOne(DB.SHEET.TRX, 'trx_id', trxId);
  var itemRows = Repo.findManyFast(DB.SHEET.ITEMS, 'trx_id', trxId)
                     .filter(function (i) { return Util.isTrue(i.is_active); });

  // Serial number per barang
  var snPerItem = {};
  Repo.findManyFast(DB.SHEET.SN, 'trx_id', trxId).forEach(function (s) {
    if (!Util.isTrue(s.is_active)) return;
    var k = String(s.item_id);
    if (!snPerItem[k]) snPerItem[k] = [];
    snPerItem[k].push(String(s.serial_number));
  });
  state.items.forEach(function (i) {
    i.sns = snPerItem[i.item_id] || [];
  });

  var approval = cekApproval_(trx, itemRows);

  state.header.nota_no = String(trx.nota_no || '');
  state.header.nota_at = Util.isoStr(trx.nota_at);
  state.header.nota_indent = String(trx.nota_indent || '');
  state.header.nota_indent_at = Util.isoStr(trx.nota_indent_at);
  state.header.gudang_confirm_at = Util.isoStr(trx.gudang_confirm_at);
  state.header.print_count = Number(trx.resep_print_count) || 0;
  state.header.last_print_at = Util.isoStr(trx.resep_last_print_at);
  state.header.branch = String(trx.branch);

  /*
   * Keterangan pesanan online.
   *
   * Admin perlu melihatnya sebelum menerbitkan nota — tempo
   * menentukan apakah barang boleh jalan tanpa pembayaran, dan
   * faktur pajak menentukan bentuk notanya.
   */
  state.header.channel = String(trx.channel || 'RITEL');
  state.header.sumber = String(trx.sumber || '');
  state.header.gedung = String(trx.gedung || '');
  state.header.metode_serah = String(trx.metode_serah || '');
  state.header.tempo_hari = Number(trx.tempo_hari) || 0;
  state.header.tempo_jatuh = Util.dateStr(trx.tempo_jatuh);
  state.header.faktur_pajak = Util.isTrue(trx.faktur_pajak);
  state.header.dp_info = Number(trx.dp_info) || 0;

  state.approval = approval;
  state.menungguApproval = approval.filter(function (a) { return !a.disetujui; }).length;
  state.bisaCetak = String(trx.stage_status) === 'DRAFT' ||
                    String(trx.stage_status) === 'SIAP_NOTA' ||
                    ['MENUNGGU_PEMBAYARAN', 'MENUNGGU_AKTIVASI', 'PROSES_AKTIVASI',
                     'AKTIVASI_SELESAI', 'SELESAI'].indexOf(String(trx.stage_status)) >= 0;
  state.bisaNota = String(trx.stage_status) === 'SIAP_NOTA' && state.menungguApproval === 0;
  state.bisaNotaIndent = String(trx.stage_status) === 'MENUNGGU_BARANG';
  state.notaContoh = contohNomorNota_();
  state.notaIndentContoh = String(Settings.get('NOTA_INDENT_CONTOH', 'SO-PWT-260919-0001'));

  // Timeline singkat
  /*
   * Riwayat perjalanan dibaca hanya kalau diminta.
   *
   * Sheet riwayat tumbuh paling cepat di antara semuanya — tiap
   * perpindahan tahap menambah baris. Membacanya pada setiap pembukaan
   * transaksi berarti membayar ongkos itu terus-menerus, padahal yang
   * membukanya jarang menggulir sampai ke bawah.
   */
  state.timeline = payload_riwayat ? Repo.findManyFast(DB.SHEET.TIMELINE, 'trx_id', trxId)
    .map(function (t) {
      return {
        at: Util.isoStr(t.at), label: String(t.event_label),
        actor: String(t.actor_name), role: String(t.actor_role),
        detail: String(t.detail || '')
      };
    }) : null;

  return state;
}

/** Riwayat perjalanan satu transaksi, dimuat terpisah */
function apiTrxTimeline(payload) {
  return withGuard_(payload, { permission: 'TIMELINE_VIEW' }, function () {
    var rows = Repo.findManyFast(DB.SHEET.TIMELINE, 'trx_id', payload.trx_id)
      .map(function (t) {
        return {
          at: Util.isoStr(t.at), label: String(t.event_label),
          actor: String(t.actor_name), role: String(t.actor_role),
          detail: String(t.detail || '')
        };
      });
    rows.sort(function (a, b) { return a.at < b.at ? -1 : 1; });
    return { list: rows };
  });
}

function apiAdminGetTrx(payload) {
  return withGuard_(payload, { permission: 'TRX_VIEW_ALL' }, function (session) {
    return apiAdminDetailData_(session, payload.trx_id);
  });
}

// ============================================================
// NOMOR NOTA
//
// Nomor nota TIDAK dibuat oleh sistem ini. Notanya terbit dari
// website resmi kantor, lalu nomornya diketik Admin ke sini.
//
// Sistem hanya menjaga dua hal:
//   1. Nomornya tidak kembar dengan transaksi lain
//   2. Setiap perubahan nomor tercatat di riwayat
//
// Contoh bentuk nomor yang dipakai ELS.ID disimpan di SETTINGS
// (NOTA_CONTOH) supaya bisa diperbarui tanpa mengubah kode.
// ============================================================

function contohNomorNota_() {
  return String(Settings.get('NOTA_CONTOH',
    'JL-PWT-260909-0130 · JL-PWT-KIOSK-260910-00009'));
}

function apiSaveNota(payload) {
  return withGuard_(payload, { permission: 'NOTA_INPUT', lock: 'ringan' }, function (session) {
    var jam = Jam.mulai('apiSaveNota');
    var trx = Repo.findOne(DB.SHEET.TRX, 'trx_id', payload.trx_id);
    if (!trx) throw appErr_('NOT_FOUND', 'Transaksi tidak ditemukan.');
    if (Util.isTrue(trx.is_void)) throw appErr_('VOIDED', 'Transaksi ini sudah dibatalkan.');

    var nota = String(payload.nota_no || '').trim();
    if (nota.length < 3) throw appErr_('BAD_NOTA', 'Nomor nota belum diisi dengan benar.');

    var stage = String(trx.stage_status);
    var ubahSaja = !!trx.nota_no;

    /*
     * Nota penjualan (JL-PWT) hanya setelah barang benar-benar siap.
     *
     * Pesanan indent punya notanya sendiri — nota pesanan (SO-PWT) —
     * yang diterbitkan lebih dulu sebagai bukti pesanan. Keduanya
     * dokumen berbeda dan keduanya disimpan.
     */
    if (!ubahSaja && stage !== 'SIAP_NOTA') {
      throw appErr_('STAGE_LOCKED',
        'Nomor nota penjualan baru bisa dibuat setelah Gudang konfirmasi barang siap. ' +
        'Status sekarang: ' + stageLabel_(stage) + '.' +
        (stage === 'MENUNGGU_BARANG'
          ? ' Untuk pesanan indent, yang dibuat sekarang nota pesanan.' : ''));
    }

    if (payload.revision !== undefined && payload.revision !== null && payload.revision !== '') {
      if (Number(payload.revision) !== (Number(trx.revision) || 0)) {
        throw appErr_('STALE_DATA',
          'Pesanan sudah diperbarui oleh ' + (trx.updated_by_name || 'orang lain') +
          '. Layar dimuat ulang supaya Anda lihat versi terbaru.');
      }
    }

    // Harga di luar batas harus disetujui dulu
    var items = Repo.findManyFast(DB.SHEET.ITEMS, 'trx_id', trx.trx_id)
                    .filter(function (i) { return Util.isTrue(i.is_active); });
    var menunggu = cekApproval_(trx, items).filter(function (a) { return !a.disetujui; });
    if (menunggu.length) {
      throw appErr_('NEED_APPROVAL',
        'Masih ada ' + menunggu.length + ' harga yang menunggu persetujuan: ' +
        menunggu.map(function (a) { return a.product_name; }).join(', ') + '.');
    }

    // Nomor nota tidak boleh kembar
    // Pemeriksaan nomor kembar dan penulisannya diantre sebentar,
    // supaya dua Admin tidak bisa memakai nomor yang sama
    jam.tandai('baca transaksi');

    var kembar = denganKunci_(function () {
      var bentrok = null;
      Repo.columns(DB.SHEET.TRX, ['trx_id', 'trx_no', 'nota_no']).forEach(function (r) {
        if (String(r.trx_id) === String(trx.trx_id)) return;
        if (String(r.nota_no || '').trim().toUpperCase() === nota.toUpperCase()) {
          bentrok = String(r.trx_no);
        }
      });
      return bentrok;
    }, 15000);
    if (kembar) {
      throw appErr_('DUP_NOTA', 'Nomor nota "' + nota + '" sudah dipakai transaksi ' + kembar + '.');
    }

    jam.tandai('periksa nota kembar');

    var now = nowIso_();
    var patch = { nota_no: nota, nota_by: session.user_id, nota_at: now };

    /*
     * Kalau sudah lunas di muka — biasanya pesanan indent yang dibayar
     * penuh sejak awal — langsung ke Teknisi. Menahannya di antrian
     * Kasir hanya membuat Kasir membuka transaksi yang tidak ada
     * pekerjaannya.
     */
    if (!ubahSaja) {
      /*
       * Setelah nota terbit, pekerjaan Teknisi boleh jalan duluan.
       *
       * Alur bawaannya: nota → Kasir → Teknisi. Yang sering terjadi
       * di lapangan, pesanan menumpuk di Kasir karena customernya
       * belum datang membayar — padahal unitnya sudah bisa dirakit
       * atau diaktivasi sambil menunggu.
       *
       * Kalau pengaturannya dinyalakan, pesanan langsung masuk
       * antrian Teknisi begitu bernota. Pembayarannya tetap wajib:
       * transaksinya tetap berdiri di daftar Kasir, dan barangnya
       * tidak bisa diserahkan sebelum lunas.
       *
       * Dibuat sebagai pengaturan, bukan diubah begitu saja, karena
       * ini mengubah urutan kerja semua divisi.
       */
      var lunas = String(trx.payment_status) === 'LUNAS';
      var teknisiDuluan = Util.isTrue(Settings.get('TEKNISI_SEBELUM_KASIR', 'FALSE'));

      if (lunas) {
        patch.stage_status = perluTeknisi_(trx) ? 'MENUNGGU_AKTIVASI' : 'SIAP_SERAH';
      } else if (teknisiDuluan && perluTeknisi_(trx)) {
        patch.stage_status = 'MENUNGGU_AKTIVASI';
      } else {
        patch.stage_status = 'MENUNGGU_PEMBAYARAN';
      }
    }

    bumpRevision_(session, trx, patch);

    logAudit_(session, {
      entity: 'TRX', entity_id: trx.trx_id, trx_no: trx.trx_no,
      action: ubahSaja ? 'UPDATE' : 'STAGE_CHANGE', field: 'nota_no',
      old_value: String(trx.nota_no || '(kosong)'), new_value: nota,
      reason: payload.reason || ''
    });
    logTimeline_(session, {
      trx_id: trx.trx_id, trx_no: trx.trx_no,
      event_code: ubahSaja ? 'NOTA_UPDATED' : 'NOTA_CREATED',
      stage_after: ubahSaja ? stage : 'MENUNGGU_PEMBAYARAN',
      event_label: ubahSaja
        ? 'Admin ' + session.full_name + ' mengubah nomor nota'
        : 'Admin ' + session.full_name + ' membuat nomor nota',
      detail: nota
    });

    if (!ubahSaja) {
      pushNotif_({
        target_role: patch.stage_status === 'MENUNGGU_AKTIVASI' ? 'TEKNISI' : 'KASIR',
        target_branch: trx.branch,
        trx_id: trx.trx_id, trx_no: trx.trx_no,
        type: patch.stage_status === 'MENUNGGU_AKTIVASI' ? 'PAID' : 'NOTA_CREATED',
        priority: 'NORMAL',
        title: patch.stage_status === 'MENUNGGU_AKTIVASI'
          ? 'Sudah lunas, siap aktivasi' : 'Transaksi siap dibayar',
        body: trx.trx_no + ' · Nota ' + nota + ' · ' + trx.cust_name_snap +
              ' · ' + formatRp_(trx.grand_total)
      });
      pushNotif_({
        target_role: 'SALES', target_branch: trx.branch,
        trx_id: trx.trx_id, trx_no: trx.trx_no,
        type: 'NOTA_CREATED', priority: 'NORMAL',
        title: 'Nota sudah dibuat',
        body: trx.trx_no + ' · Nota ' + nota
      });
    }

    return apiAdminDetailData_(session, trx.trx_id);
  });
}

// ============================================================
// CETAK RESEP
// ============================================================

/**
 * Data resep diambil ulang dari database saat tombol ditekan,
 * bukan dari layar yang mungkin sudah lama dibuka.
 */
function apiPrintResep(payload) {
  return withGuard_(payload, { permission: 'RESEP_PRINT', lock: 'ringan' }, function (session) {
    var jam = Jam.mulai('apiPrintResep');
    var trx = Repo.findOne(DB.SHEET.TRX, 'trx_id', payload.trx_id);
    if (!trx) throw appErr_('NOT_FOUND', 'Transaksi tidak ditemukan.');

    /*
     * Resep bisa dicetak sejak pesanan dikonfirmasi Sales.
     *
     * Dulu harus menunggu Gudang selesai. Padahal resep justru dipakai
     * Gudang sebagai panduan mengambil barang — menunggu Gudang selesai
     * dulu membuat urutannya terbalik. Yang belum ada saat itu hanya
     * serial number, dan itu memang diisi belakangan.
     */
    var stage = String(trx.stage_status);
    if (stage === 'DRAFT') {
      throw appErr_('STAGE_LOCKED',
        'Pesanan ini masih draft. Konfirmasi dulu, baru resepnya bisa dicetak.');
    }
    if (stage === 'DIBATALKAN') {
      throw appErr_('STAGE_LOCKED', 'Pesanan ini sudah dibatalkan.');
    }

    var items = Repo.findManyFast(DB.SHEET.ITEMS, 'trx_id', trx.trx_id)
      .filter(function (i) { return Util.isTrue(i.is_active); })
      .sort(function (a, b) { return Number(a.line_no) - Number(b.line_no); });

    var snPerItem = {};
    Repo.findManyFast(DB.SHEET.SN, 'trx_id', trx.trx_id).forEach(function (s) {
      if (!Util.isTrue(s.is_active)) return;
      var k = String(s.item_id);
      if (!snPerItem[k]) snPerItem[k] = [];
      snPerItem[k].push(String(s.serial_number));
    });

    var hitung = (Number(trx.resep_print_count) || 0) + 1;
    Repo.update(DB.SHEET.TRX, trx._row, {
      resep_print_count: hitung,
      resep_last_print_at: nowIso_(),
      resep_last_print_by: session.full_name
    });

    logAudit_(session, {
      entity: 'TRX', entity_id: trx.trx_id, trx_no: trx.trx_no,
      action: 'UPDATE', field: 'resep_print',
      old_value: 'cetak ke-' + (hitung - 1), new_value: 'cetak ke-' + hitung
    });
    logTimeline_(session, {
      trx_id: trx.trx_id, trx_no: trx.trx_no,
      event_code: 'RESEP_PRINT', stage_after: stage,
      event_label: 'Admin ' + session.full_name + ' mencetak resep',
      detail: 'Cetakan ke-' + hitung
    });

    jam.tandai('baca transaksi, barang & SN');
    jam.selesai();

    return {
      toko: {
        nama: String(Settings.get('COMPANY_NAME', 'ELS.ID')),
        alamat: String(Settings.get('COMPANY_ADDRESS', '')),
        telepon: String(Settings.get('COMPANY_PHONE', '')),
        logo: String(Settings.get('LOGO_URL', '')),
        kertas: String(Settings.get('PAPER_SIZE', 'A5')).toUpperCase()
      },
      header: {
        trx_no: String(trx.trx_no),
        trx_date: Util.dateStr(trx.trx_date),
        nota_no: String(trx.nota_no || ''),
        cust_name: String(trx.cust_name_snap),
        cust_phone: Util.hp(trx.cust_phone_snap),
        cust_member: String(trx.cust_member_snap || ''),
        sales_name: String(trx.sales_name || ''),
        sales_code: String(trx.sales_code || ''),
        order_note: String(trx.order_note || ''),
        subtotal: Number(trx.subtotal) || 0,
        discount_total: Number(trx.discount_total) || 0,
        grand_total: Number(trx.grand_total) || 0,
        paid_total: Number(trx.paid_total) || 0,
        outstanding: Number(trx.outstanding) || 0,
        payment_status: String(trx.payment_status),
        gudang_confirm_at: Util.isoStr(trx.gudang_confirm_at),
        stage_status: String(trx.stage_status),
        indent: String(trx.stage_status) === 'MENUNGGU_BARANG',
        indent_note: String(trx.indent_note || ''),

        /*
         * Keterangan online ikut tercetak di resep.
         *
         * Resep dibawa bersama barangnya. Kalau tempo atau faktur
         * pajak hanya tertulis di layar, yang memegang barang di
         * jalan tidak tahu — dan pertanyaan yang muncul kemudian
         * harus ditelusuri ulang dari awal.
         */
        channel: String(trx.channel || 'RITEL'),
        penyiap: String(trx.eksekusi_pic_nama || trx.gudang_petugas_nama || ''),
        cara_bayar: String(trx.cara_bayar || ''),

        /*
         * Keadaan pembayaran yang sebenarnya ikut dikirim.
         *
         * Pilihan Sales adalah rencana: "akan lunas", "akan DP".
         * Yang dicetak di resep harus keadaan nyata saat itu —
         * selembar kertas yang menyebut "Lunas" padahal belum ada
         * uang masuk bisa dipakai untuk membawa barang keluar.
         */
        payment_status: String(trx.payment_status || ''),
        paid_total: Number(trx.paid_total) || 0,
        outstanding: Number(trx.outstanding) || 0,
        tempo_hari: Number(trx.tempo_hari) || 0,
        dp_info: Number(trx.dp_info) || 0,
        tempo_jatuh: Util.dateStr(trx.tempo_jatuh),
        faktur_pajak: Util.isTrue(trx.faktur_pajak),
        metode_serah: String(trx.metode_serah || ''),
        sumber: String(trx.sumber || ''),
        print_count: hitung,
        dicetak_oleh: session.full_name,
        dicetak_pada: nowIso_()
      },
      items: items.map(function (i, n) {
        return {
          no: n + 1,
          product_code: String(i.product_code),
          product_name: String(i.product_name),
          qty: Number(i.qty) || 0,
          unit_price: Number(i.unit_price) || 0,
          master_price: Number(i.master_price) || 0,

          /*
           * Harga jual sebelum diskon dan besar diskonnya dikirim
           * terpisah, supaya resep bisa menampilkan tiga angka:
           * harga, potongan, dan yang dibayar.
           *
           * Tanpa itu resep hanya memuat harga akhir — dan saat
           * diperiksa, tidak ada cara membedakan barang yang memang
           * murah dari barang yang diberi diskon besar.
           */
          base_price: Number(i.base_price) || Number(i.master_price) || Number(i.unit_price) || 0,
          diskon: Math.max(
            (Number(i.base_price) || Number(i.master_price) || Number(i.unit_price) || 0) -
            (Number(i.unit_price) || 0), 0),

          line_total: (Number(i.qty) || 0) * (Number(i.unit_price) || 0),
          item_note: String(i.item_note || ''),
          sns: snPerItem[String(i.item_id)] || []
        };
      })
    };
  });
}

// ============================================================
// PENGATURAN NOTA — jalankan sekali dari editor
// ============================================================

function siapkanPengaturanNota() {
  var sh = Repo.sheet(DB.SHEET.SETTINGS);
  var ada = {};
  Repo.columns(DB.SHEET.SETTINGS, ['key']).forEach(function (r) { ada[String(r.key).trim()] = true; });

  var now = nowIso_();
  var baru = [
    ['REVIEW_LINK', 'https://share.google/JwzF1eSzh5Z65XET9', 'TEXT', 'CUSTOMER',
     'Tautan Google Bisnis untuk ulasan customer. Muncul di halaman terima kasih setelah customer mengisi form QR.'],
    ['NOTA_CONTOH', 'JL-PWT-260909-0130 · JL-PWT-KIOSK-260910-00009', 'TEXT', 'ADMIN',
     'Contoh bentuk nomor nota dari website resmi kantor. Hanya sebagai petunjuk di layar Admin, bukan aturan yang memaksa.']
  ].filter(function (s) { return !ada[s[0]]; });

  if (baru.length) {
    sh.getRange(sh.getLastRow() + 1, 1, baru.length, 7).setValues(
      baru.map(function (s) { return [s[0], s[1], s[2], s[3], s[4], now, 'SETUP']; }));
  }
  Settings.bust();

  return kabar_((baru.length ? 'Pengaturan NOTA_CONTOH ditambahkan.' : 'Pengaturan sudah ada.') +
    '\n\nNomor nota diketik manual oleh Admin, mengikuti nomor dari website resmi kantor. ' +
    'Sistem hanya mengecek supaya tidak kembar.');
}

// ============================================================
// KOREKSI SERIAL NUMBER
//
// Gudang hanya bisa mengisi SN selama pesanan masih di tangannya.
// Setelah lewat, salah input tetap perlu bisa dibetulkan — kalau
// tidak, orang akan mencatat koreksinya di kertas dan itu hilang.
//
// Karena itu Admin boleh mengoreksi SN pada tahap mana pun, dengan
// syarat mengisi alasan. SN lama tidak dihapus, hanya dinonaktifkan.
// ============================================================

function apiKoreksiSn(payload) {
  return withGuard_(payload, { permission: 'SN_INPUT', lock: true }, function (session) {
    var trx = Repo.findOne(DB.SHEET.TRX, 'trx_id', payload.trx_id);
    if (!trx) throw appErr_('NOT_FOUND', 'Transaksi tidak ditemukan.');
    if (Util.isTrue(trx.is_void)) throw appErr_('VOIDED', 'Transaksi ini sudah dibatalkan.');

    var it = Repo.findOne(DB.SHEET.ITEMS, 'item_id', payload.item_id);
    if (!it || String(it.trx_id) !== String(trx.trx_id)) {
      throw appErr_('NOT_FOUND', 'Barang tidak ditemukan di pesanan ini.');
    }
    if (!Util.isTrue(it.is_active)) throw appErr_('VOIDED', 'Barang ini sudah dibatalkan.');

    var alasan = String(payload.reason || '').trim();
    if (alasan.length < 4) {
      throw appErr_('NO_REASON', 'Alasan koreksi wajib diisi, minimal beberapa kata.');
    }

    // SN tidak boleh bentrok dengan transaksi lain
    var snMasuk = {};
    snMasuk[String(it.item_id)] = payload.sns || [];
    var masalah = periksaSn_(trx, [it], snMasuk);
    if (masalah.length) {
      var e = appErr_('SN_USED', masalah[0].pesan);
      e.details = masalah;
      throw e;
    }

    var sebelum = Repo.findManyFast(DB.SHEET.SN, 'item_id', it.item_id)
      .filter(function (x) { return Util.isTrue(x.is_active); })
      .sort(function (a, b) { return Number(a.unit_seq) - Number(b.unit_seq); })
      .map(function (x) { return String(x.serial_number); })
      .join(', ');

    /*
     * Memakai penyimpan SN yang sama dengan Gudang.
     *
     * Dulu ada dua fungsi terpisah untuk pekerjaan yang sama. Saat
     * yang satu diperbaiki dan dibuang, yang memanggilnya di sini
     * ikut rusak — dan baru ketahuan waktu Admin mengoreksi SN.
     *
     * Satu fungsi untuk satu pekerjaan, dipakai bersama.
     */
    var masukSatu = {};
    masukSatu[String(it.item_id)] = payload.sns || [];
    simpanSnBorongan_(session, trx, [it], masukSatu, nowIso_());

    bumpRevision_(session, trx);
    bustSnHistCache_();

    var sesudah = Repo.findManyFast(DB.SHEET.SN, 'item_id', it.item_id)
      .filter(function (x) { return Util.isTrue(x.is_active); })
      .sort(function (a, b) { return Number(a.unit_seq) - Number(b.unit_seq); })
      .map(function (x) { return String(x.serial_number); })
      .join(', ');

    logAudit_(session, {
      entity: 'SN', entity_id: it.item_id, trx_no: trx.trx_no,
      action: 'OVERRIDE', field: 'sn_koreksi',
      old_value: sebelum || '(kosong)', new_value: sesudah || '(kosong)',
      reason: alasan
    });
    logTimeline_(session, {
      trx_id: trx.trx_id, trx_no: trx.trx_no,
      event_code: 'SN_KOREKSI', stage_after: String(trx.stage_status),
      event_label: Fmt_roleLabel_(session.role) + ' ' + session.full_name +
                   ' mengoreksi SN ' + it.product_name,
      detail: (sebelum || '(kosong)') + ' → ' + (sesudah || '(kosong)') + ' · ' + alasan
    });

    return apiAdminDetailData_(session, trx.trx_id);
  });
}

function Fmt_roleLabel_(role) {
  return { SALES: 'Sales', SALES_ONLINE: 'Sales Online',
           GUDANG: 'Gudang', EKSEKUSI: 'Tim Eksekusi',
           ADMIN: 'Admin', KASIR: 'Kasir',
           TEKNISI: 'Teknisi', SUPERADMIN: 'Super Admin' }[role] || role;
}

// ============================================================
// DAFTAR PESANAN UNTUK CETAK RESEP
//
// Dipakai Sales dan Admin. Sales ikut bisa mencetak supaya tidak
// menumpuk di satu orang saat ramai — resepnya sama, siapa yang
// mencetak tercatat di riwayat.
// ============================================================

function apiResepList(payload) {
  return withGuard_(payload, { permission: 'RESEP_PRINT' }, function (session) {
    var hari = Number(payload.hari === undefined ? 1 : payload.hari);
    var q = String(payload.q || '').trim().toUpperCase();
    var semuaCabang = hasPerm_(session, 'TRX_VIEW_ALL');

    /*
     * Tab khusus draft.
     *
     * Draft tidak punya tanggal nota dan umurnya bisa berhari-hari
     * sambil menunggu customer memastikan. Disatukan dengan tab
     * periode, dia gampang lewat begitu lewat dari "hari ini" —
     * padahal barangnya sedang di-keep dan resepnya justru yang
     * ditempel di barang itu.
     */
    var hanyaDraft = String(payload.scope || '') === 'draft';
    if (hanyaDraft) hari = 0;

    /*
     * Dibaca dari sumbernya, bukan salinan.
     *
     * Gejalanya sama persis dengan yang dulu terjadi di layar Sales
     * NB: daftarnya muncul sekali, lalu kosong sendiri beberapa
     * detik kemudian walau tidak ada yang berubah.
     *
     * Sebabnya salinan blok data yang tidak sejajar dengan isi
     * sheet. Untuk daftar yang dipakai memutuskan "mana yang perlu
     * dicetak", daftar yang kadang kosong jauh lebih mahal daripada
     * satu pembacaan tambahan.
     */
    try { Repo.bustSheet(DB.SHEET.TRX); } catch (eB) {}

    var batas = new Date();
    batas.setDate(batas.getDate() - (hari > 0 ? hari - 1 : 0));
    var batasStr = Utilities.formatDate(batas, 'Asia/Jakarta', 'yyyy-MM-dd');

    var rows = Repo.columns(DB.SHEET.TRX, [
      'trx_id', 'trx_no', 'branch', 'trx_date', 'cust_name_snap',
      'sales_name', 'sales_user_id', 'stage_status', 'grand_total',
      'channel', 'resep_print_count', 'is_void'
    ]);

    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var t = rows[i];
      if (Util.isTrue(t.is_void)) continue;

      var st = String(t.stage_status);

      /*
       * Hanya pesanan yang belum sampai Kasir.
       *
       * Resep dipakai Gudang untuk menyiapkan barang dan Admin untuk
       * menerbitkan nota. Begitu transaksinya masuk Kasir, resepnya
       * sudah tidak dipakai siapa pun — yang berlaku nota.
       *
       * Membiarkannya tetap di daftar cuma memanjangkan layar dengan
       * pesanan yang sudah lewat, dan membuat Sales ragu mana yang
       * masih perlu dicetak. Kalau memang perlu cetak ulang setelah
       * itu, mintanya ke Admin — dia yang memegang notanya.
       */
      /*
       * Draft ikut boleh dicetak.
       *
       * Terlewat di daftar tahap ini — jadi walau draft sudah lolos
       * pemeriksaan di bawah, dia tersaring lebih dulu di sini dan
       * tidak pernah muncul di menu Cetak Resep.
       *
       * Resep draft dipakai untuk ditempel di barang yang di-keep,
       * jadi justru itu yang paling dibutuhkan lebih awal.
       */
      var bolehCetak = ['DRAFT', 'MENUNGGU_GUDANG', 'PROSES_GUDANG',
                        'SIAP_NOTA', 'MENUNGGU_BARANG'].indexOf(st) >= 0;

      // Admin tetap bisa mencetak ulang pada tahap mana pun
      if (!bolehCetak && !hasPerm_(session, 'NOTA_INPUT')) continue;
      /*
       * Draft pesanan online boleh dicetak resepnya.
       *
       * Sales Online membuat pesanan dari luar toko dan belum
       * mengonfirmasinya — Eksekusi tetap bisa menyiapkan barangnya
       * sambil menunggu. Resepnya yang dipakai untuk mengambil
       * barang dari rak.
       *
       * Untuk yang lain draft tetap disembunyikan: belum pasti, dan
       * mencetaknya hanya membuat kertas yang tidak terpakai.
       */
      if (st === 'DIBATALKAN') continue;

      if (st === 'DRAFT') {
        var bolehDraft = ['EKSEKUSI', 'SALES_ONLINE', 'SUPERADMIN']
                           .indexOf(String(session.role)) >= 0;
        if (!bolehDraft) continue;
        if (String(t.channel || '').toUpperCase() !== 'ONLINE') continue;
      } else if (hanyaDraft) {
        continue;      // tab draft hanya berisi draft
      }
      if (Util.dateStr(t.trx_date) < batasStr) continue;
      if (!semuaCabang && String(t.branch) !== String(session.branch)) continue;

      /*
       * Siapa melihat resep siapa.
       *
       * Sales hanya pesanan yang dia input sendiri. Tapi Tim Eksekusi
       * juga mencetak resep — justru dia yang memakainya untuk
       * menyiapkan barang — dan pesanannya bukan dia yang input.
       *
       * Jadi penyaringnya dibedakan: Sales per orang, Eksekusi per
       * saluran.
       */
      /*
       * Resep bisa dicetak siapa pun di divisinya.
       *
       * Sales sering membuat pesanan dari luar toko — dari rumah,
       * dari tempat customer. Resepnya tetap harus keluar di toko,
       * dan yang ada di sana saat itu bukan dia.
       *
       * Dulu tiap orang hanya melihat pesanan yang dia input
       * sendiri, jadi pesanan seperti itu menggantung sampai
       * pembuatnya datang. Sekarang satu divisi saling bisa
       * mencetakkan.
       *
       * Yang tetap dipisah cuma saluran: Gudang tidak perlu melihat
       * resep pesanan online, dan sebaliknya.
       */
      var peranR = String(session.role);
      var chR = String(t.channel || 'RITEL').toUpperCase();

      if (peranR === 'EKSEKUSI' || peranR === 'SALES_ONLINE') {
        if (chR !== 'ONLINE') continue;
      } else if (peranR === 'GUDANG' || peranR === 'SALES') {
        if (chR === 'ONLINE') continue;
      }

      if (q) {
        var bahan = [t.trx_no, t.cust_name_snap, t.sales_name].join(' ').toUpperCase();
        if (bahan.indexOf(q) < 0) continue;
      }

      out.push({
        trx_id: String(t.trx_id), trx_no: String(t.trx_no),
        trx_date: Util.dateStr(t.trx_date),
        cust_name: String(t.cust_name_snap),
        sales_name: String(t.sales_name || ''),
        stage_status: st, stage_label: stageLabel_(st),
        grand_total: Number(t.grand_total) || 0,
        print_count: Number(t.resep_print_count) || 0
      });
    }

    out.sort(function (a, b) { return a.trx_no < b.trx_no ? 1 : -1; });
    return { list: out.slice(0, 100), total: out.length };
  });
}

// ============================================================
// NOTA PESANAN INDENT
//
// Dokumen yang berbeda dari nota penjualan, dan keduanya disimpan.
//
// Nota pesanan (SO-PWT) terbit saat barang belum ada. Customer
// membawanya sebagai bukti, dan bisa membayar DP atau lunas dengan
// nota itu. Saat barangnya datang, customer membawa nota itu kembali,
// Admin menariknya, lalu menerbitkan nota penjualan (JL-PWT).
//
// Kalau keduanya disimpan di satu kolom, nomor pesanan akan tertimpa
// nomor penjualan — dan jejak bahwa transaksi ini pernah jadi pesanan
// indent hilang beserta bukti pembayaran yang mengacu ke sana.
// ============================================================

function apiSaveNotaIndent(payload) {
  return withGuard_(payload, { permission: 'NOTA_INPUT', lock: 'ringan' }, function (session) {
    var trx = Repo.findOne(DB.SHEET.TRX, 'trx_id', payload.trx_id);
    if (!trx) throw appErr_('NOT_FOUND', 'Transaksi tidak ditemukan.');
    if (Util.isTrue(trx.is_void)) throw appErr_('VOIDED', 'Transaksi ini sudah dibatalkan.');

    var nota = String(payload.nota_indent || '').trim();
    if (nota.length < 3) throw appErr_('BAD_NOTA', 'Nomor nota pesanan belum diisi dengan benar.');

    /*
     * Memastikan kolomnya benar-benar ada sebelum menyimpan.
     *
     * Penyimpanan mengabaikan kolom yang tidak dikenal tanpa berkata
     * apa-apa. Akibatnya nomor nota hilang begitu saja, sementara
     * pemberitahuan tetap terkirim karena teksnya dibuat dari yang
     * diketik — jadi terlihat seperti berhasil padahal tidak.
     *
     * Lebih baik gagal dengan jelas daripada berhasil di layar tapi
     * kosong di database.
     */
    if (Repo.headers(DB.SHEET.TRX).indexOf('nota_indent') < 0) {
      throw appErr_('NO_COLUMN',
        'Kolom nota_indent belum ada di sheet TRANSACTIONS, jadi nomornya tidak bisa disimpan. ' +
        'Jalankan siapkanNotaIndent() dari editor Apps Script lebih dulu.');
    }

    var ubahSaja = !!String(trx.nota_indent || '').trim();

    /*
     * Nota pesanan hanya boleh diisi atau diubah selama barangnya
     * belum datang.
     *
     * Setelah itu nomornya sudah ada di tangan customer sebagai bukti
     * pesanan, dan yang diterbitkan berikutnya adalah nota penjualan —
     * dokumen yang berbeda. Menimpa nomor SO dengan nomor JL membuat
     * bukti yang dipegang customer tidak cocok dengan apa pun.
     */
    if (String(trx.stage_status) !== 'MENUNGGU_BARANG') {
      throw appErr_('STAGE_LOCKED',
        'Nota pesanan tidak bisa diubah lagi karena barangnya sudah datang. ' +
        'Yang diterbitkan sekarang nota penjualan (JL), di kotak yang sama. ' +
        'Status: ' + stageLabel_(trx.stage_status) + '.');
    }

    // Tidak boleh kembar, termasuk dengan nota pesanan transaksi lain
    var kembar = denganKunci_(function () {
      var bentrok = null;
      Repo.columns(DB.SHEET.TRX, ['trx_id', 'trx_no', 'nota_indent']).forEach(function (r) {
        if (String(r.trx_id) === String(trx.trx_id)) return;
        if (String(r.nota_indent || '').trim().toUpperCase() === nota.toUpperCase()) {
          bentrok = String(r.trx_no);
        }
      });
      return bentrok;
    }, 15000);
    if (kembar) {
      throw appErr_('DUP_NOTA',
        'Nomor nota pesanan "' + nota + '" sudah dipakai transaksi ' + kembar + '.');
    }

    var now = nowIso_();
    bumpRevision_(session, trx, {
      nota_indent: nota, nota_indent_at: now, nota_indent_by: session.user_id
    });

    // Dibaca ulang untuk memastikan benar-benar mendarat
    var cek = Repo.findOne(DB.SHEET.TRX, 'trx_id', trx.trx_id);
    if (!cek || String(cek.nota_indent || '').trim() !== nota) {
      throw appErr_('SAVE_FAILED',
        'Nomor nota pesanan tidak tersimpan. Kemungkinan kolom nota_indent belum ada ' +
        'di sheet TRANSACTIONS — jalankan siapkanNotaIndent() dari editor.');
    }

    logAudit_(session, {
      entity: 'TRX', entity_id: trx.trx_id, trx_no: trx.trx_no,
      action: ubahSaja ? 'UPDATE' : 'CREATE', field: 'nota_indent',
      old_value: String(trx.nota_indent || '(kosong)'), new_value: nota,
      reason: payload.reason || ''
    });
    logTimeline_(session, {
      trx_id: trx.trx_id, trx_no: trx.trx_no,
      event_code: 'NOTA_INDENT', stage_after: String(trx.stage_status),
      event_label: 'Admin ' + session.full_name +
        (ubahSaja ? ' mengubah nomor nota pesanan' : ' membuat nota pesanan indent'),
      detail: nota
    });

    if (!ubahSaja) {
      pushNotif_({
        target_role: 'KASIR', target_branch: trx.branch,
        trx_id: trx.trx_id, trx_no: trx.trx_no,
        type: 'NOTA_CREATED', priority: 'NORMAL',
        title: 'Nota pesanan indent — boleh DP atau lunas',
        body: trx.trx_no + ' · ' + nota + ' · ' + trx.cust_name_snap +
              ' · ' + formatRp_(trx.grand_total) + ' · barang belum datang'
      });
      pushNotif_({
        target_role: 'SALES', target_branch: trx.branch,
        trx_id: trx.trx_id, trx_no: trx.trx_no,
        type: 'NOTA_CREATED', priority: 'NORMAL',
        title: 'Nota pesanan sudah dibuat',
        body: trx.trx_no + ' · ' + nota + ' · bisa diserahkan ke customer'
      });
    }

    return apiAdminDetailData_(session, trx.trx_id);
  });
}

/** Menyiapkan kolom nota pesanan indent — jalankan sekali dari editor */
function siapkanNotaIndent() {
  var sh = Repo.sheet(DB.SHEET.TRX);
  var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0]
               .map(function (v) { return String(v).trim(); });

  var pesan = [];
  ['nota_indent', 'nota_indent_at', 'nota_indent_by'].forEach(function (kol) {
    if (head.indexOf(kol) >= 0) { pesan.push('Kolom ' + kol + ' sudah ada.'); return; }
    var k = sh.getLastColumn() + 1;
    if (sh.getMaxColumns() < k) sh.insertColumnsAfter(sh.getMaxColumns(), 1);
    sh.getRange(1, k).setValue(kol).setFontWeight('bold').setBackground('#f1f3f4');
    sh.setColumnWidth(k, 170);
    head.push(kol);
    pesan.push('Kolom ' + kol + ' ditambahkan.');
  });

  var adaSetting = false;
  Repo.columns(DB.SHEET.SETTINGS, ['key']).forEach(function (r) {
    if (String(r.key).trim() === 'NOTA_INDENT_CONTOH') adaSetting = true;
  });
  if (!adaSetting) {
    var shS = Repo.sheet(DB.SHEET.SETTINGS);
    shS.getRange(shS.getLastRow() + 1, 1, 1, 7).setValues([[
      'NOTA_INDENT_CONTOH', 'SO-PWT-260919-0001', 'TEXT', 'ADMIN',
      'Contoh bentuk nomor nota pesanan indent dari sistem kantor. Hanya petunjuk di layar.',
      nowIso_(), 'SETUP'
    ]]);
    pesan.push('Pengaturan NOTA_INDENT_CONTOH ditambahkan.');
  }

  Repo.clearHeaderCache();
  bersihkanCache();

  return kabar_(pesan.join('\n') + '\n\n' +
    'Sekarang pesanan indent punya nota sendiri (SO-PWT), terpisah dari nota ' +
    'penjualan (JL-PWT). Keduanya tersimpan, jadi saat barang datang Admin bisa ' +
    'melihat nomor nota pesanannya sambil membuat nota penjualan.');
}
