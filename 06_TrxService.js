/**
 * ELS.ID WORKFLOW SYSTEM — v3
 * File : 06_TrxService.gs
 *
 * Baru di v3:
 * Setiap transaksi menyimpan dua hal terpisah —
 *   sales_user_id : akun yang mengetik  → untuk audit log
 *   sales_code    : sales yang menjual  → untuk laporan penjualan
 * Ini diperlukan karena akun login dibuat per divisi, dipakai
 * bergantian oleh beberapa orang.
 *
 * Tetap dari v2: setiap perubahan langsung mengembalikan isi pesanan
 * terbaru, supaya browser tidak perlu bertanya dua kali.
 */

// ============================================================
// NOMOR TRANSAKSI
// ============================================================

function generateTrxNo_(branch) {
  // Bagian yang benar-benar bisa bentrok antar orang: mengambil nomor
  // urut. Hanya ini yang perlu diantre, bukan seluruh penyimpanan.
  return denganKunci_(function () { return ambilNomorTrx_(branch); }, 25000);
}

function ambilNomorTrx_(branch) {
  var dateKey = Util.todayStr();
  var prefix = Settings.get('TRX_PREFIX', 'TRX');
  var key = 'TRX|' + branch;

  /*
   * Nomor yang sudah terpakai dibaca LANGSUNG dari sheet, bukan dari
   * salinan.
   *
   * Ini penyebab nomor kembar yang pernah terjadi. Dua pesanan yang
   * dikonfirmasi hampir bersamaan sama-sama memeriksa lewat salinan
   * sementara. Yang kedua belum sempat melihat baris yang baru saja
   * ditulis yang pertama, jadi keduanya merasa nomornya masih kosong
   * dan dua transaksi berbeda mendapat nomor yang sama.
   *
   * Membaca satu kolom langsung dari sheet lebih lambat sepersekian
   * detik, tapi hasilnya pasti — dan nomor transaksi kembar adalah
   * jenis kesalahan yang merembet ke nota, pembayaran, dan laporan.
   */
  var terpakai = {};
  try {
    var sh = Repo.sheet(DB.SHEET.TRX);
    var head = Repo.headers(DB.SHEET.TRX);
    var iNo = head.indexOf('trx_no');
    var lr = sh.getLastRow();

    /*
     * Cukup memeriksa bagian bawah sheet.
     *
     * Nomor hari ini selalu berada di baris-baris terakhir, karena
     * transaksi ditulis berurutan. Membaca seluruh kolom dari baris
     * pertama berarti menyeret ribuan baris lama yang nomornya sudah
     * pasti tidak bentrok — dan itu 2 detik dari 6 detik konfirmasi.
     *
     * Delapan ratus baris terakhir jauh lebih dari cukup: satu hari
     * tersibuk pun tidak sampai tiga ratus transaksi.
     */
    var mulaiBaris = Math.max(2, lr - 800);

    if (iNo >= 0 && lr > 1) {
      var kolom = sh.getRange(mulaiBaris, iNo + 1, lr - mulaiBaris + 1, 1).getValues();
      for (var i = 0; i < kolom.length; i++) {
        var v = String(kolom[i][0] || '').trim();
        if (v) terpakai[v] = true;
      }
    }
  } catch (e) {}

  var row = Repo.findOne(DB.SHEET.COUNTERS, 'counter_key', key);
  var next;

  if (!row || Util.dateStr(row.scope_date) !== dateKey) {
    next = maxTrxSeqToday_(branch, dateKey) + 1;
  } else {
    next = Number(row.last_number || 0) + 1;
  }

  // Dinaikkan sampai benar-benar belum terpakai
  var trxNo = prefix + '-' + dateKey.replace(/-/g, '') + '-' + Util.pad(next, 3);
  var guard = 0;
  while (terpakai[trxNo] && guard < 200) {
    next++; guard++;
    trxNo = prefix + '-' + dateKey.replace(/-/g, '') + '-' + Util.pad(next, 3);
  }

  if (row) {
    Repo.update(DB.SHEET.COUNTERS, row._row,
      { scope_date: dateKey, last_number: next, updated_at: nowIso_() });
  } else {
    Repo.append(DB.SHEET.COUNTERS,
      { counter_key: key, scope_date: dateKey, last_number: next, updated_at: nowIso_() });
  }

  return trxNo;
}

function maxTrxSeqToday_(branch, dateKey) {
  var rows = Repo.columns(DB.SHEET.TRX, ['trx_id', 'trx_no', 'branch', 'trx_date']);
  var max = 0;
  for (var i = 0; i < rows.length; i++) {
    if (Util.dateStr(rows[i].trx_date) !== dateKey) continue;
    if (String(rows[i].branch) !== String(branch)) continue;
    var m = String(rows[i].trx_no).match(/-(\d+)$/);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max;
}

// ============================================================
// HITUNG & SUSUN
// ============================================================

/**
 * Menghitung jumlah barang dan totalnya saja.
 *
 * Dipakai untuk jawaban ringkas setelah menyimpan — tidak perlu
 * membaca SN, pembayaran, dan riwayat hanya untuk menampilkan satu
 * baris pemberitahuan.
 */
function hitungCepatTrx_(trxId) {
  var t = Repo.findOne(DB.SHEET.TRX, 'trx_id', trxId);
  return {
    count: t ? (Number(t.item_count) || 0) : 0,
    grand: t ? (Number(t.grand_total) || 0) : 0
  };
}

/**
 * Menghitung ulang total transaksi.
 *
 * trxKnown: baris transaksi yang SUDAH ada di tangan pemanggil.
 * Kalau diberikan, sheet transaksi tidak dibaca ulang — penulisan
 * barang barusan membatalkan salinan, jadi pembacaan berikutnya
 * mengambil seluruh isinya dari nol.
 */
function recalcTrx_(trxId, trxKnown) {
  var items = Repo.findManyFast(DB.SHEET.ITEMS, 'trx_id', trxId)
                  .filter(function (i) { return Util.isTrue(i.is_active); });

  var subtotal = 0, master = 0, count = 0;
  items.forEach(function (i) {
    var qty = Number(i.qty) || 0;
    var price = Number(i.unit_price) || 0;
    subtotal += qty * price;
    // Diskon dihitung dari harga jual yang berlaku, bukan harga katalog.
    // Sales sering menaikkan harga karena ada tambahan seperti Office —
    // kalau diskon tetap dipotong dari harga katalog, angkanya salah.
    master += qty * (Number(i.base_price) || Number(i.master_price) || price);
    count++;
  });

  var trx = trxKnown || Repo.findOne(DB.SHEET.TRX, 'trx_id', trxId);
  if (!trx) return null;

  var paid = Number(trx.paid_total) || 0;
  var baru = {
    item_count: count, subtotal: subtotal,
    discount_total: Math.max(master - subtotal, 0),
    grand_total: subtotal, outstanding: subtotal - paid
  };

  /*
   * Hanya menulis kalau angkanya memang berubah.
   *
   * Satu kali simpan bisa memanggil perhitungan ini beberapa kali, dan
   * tiap penulisan ke spreadsheet memakan ratusan milidetik. Sebagian
   * besar panggilan itu menulis angka yang sama persis dengan yang
   * sudah ada — waktu yang terbuang tanpa mengubah apa pun.
   */
  var berubah = false;
  Object.keys(baru).forEach(function (k) {
    if (Number(trx[k] || 0) !== Number(baru[k] || 0)) berubah = true;
  });

  // Dikumpulkan dulu, ditulis sekali bersama perubahan lain pada
  // baris yang sama
  if (berubah) Repo.tundaUpdate(DB.SHEET.TRX, trx._row, baru);

  // Total berubah berarti status pembayaran bisa ikut berubah —
  // misalnya yang tadinya lunas jadi kurang karena ada barang tambahan.
  if (paid > 0 && typeof hitungPembayaran_ === 'function') {
    try { hitungPembayaran_(trxId); } catch (e) {}
  }

  // Angkanya ikut dikembalikan, supaya pemanggil tidak perlu
  // membaca ulang transaksinya hanya untuk tahu totalnya
  return {
    row: trx._row,
    item_count: baru.item_count,
    subtotal: baru.subtotal,
    discount_total: baru.discount_total,
    grand_total: baru.grand_total
  };
}

function bumpRevision_(session, trx, extra) {
  var patch = {
    revision: (Number(trx.revision) || 0) + 1,
    updated_at: nowIso_(),
    updated_by: session.user_id,
    updated_by_name: session.full_name
  };
  Object.keys(extra || {}).forEach(function (k) { patch[k] = extra[k]; });

  /*
   * Digabung dengan perubahan lain pada baris yang sama.
   *
   * Perhitungan total dan pembayaran biasanya baru saja menulis ke
   * baris ini juga. Ketiganya jadi satu perjalanan ke spreadsheet,
   * bukan tiga.
   */
  Repo.tundaUpdate(DB.SHEET.TRX, trx._row, patch);

  // Salinan di memori ikut diperbarui, supaya kode setelahnya membaca
  // nilai yang benar tanpa harus menunggu penulisan
  Object.keys(patch).forEach(function (k) { trx[k] = patch[k]; });

  return patch.revision;
}

function buildTrxState_(session, trxId) {
  // Serial number per barang, supaya bisa dibetulkan langsung dari
  // layar pesanan tanpa berpindah halaman
  var snPerItem_ = {};
  try {
    Repo.findManyFast(DB.SHEET.SN, 'trx_id', trxId).forEach(function (x) {
      if (!Util.isTrue(x.is_active)) return;
      var k = String(x.item_id);
      if (!snPerItem_[k]) snPerItem_[k] = [];
      snPerItem_[k].push({ seq: Number(x.unit_seq) || 0, sn: String(x.serial_number) });
    });
  } catch (e) {}

  var trx = Repo.findOne(DB.SHEET.TRX, 'trx_id', trxId);
  if (!trx) throw appErr_('NOT_FOUND', 'Transaksi tidak ditemukan.');

  var maxDisc = Settings.num('MAX_DISCOUNT_PCT_SALES', 5);
  var items = Repo.findManyFast(DB.SHEET.ITEMS, 'trx_id', trxId)
    .filter(function (i) { return Util.isTrue(i.is_active); })
    .sort(function (a, b) { return Number(a.line_no) - Number(b.line_no); })
    .map(function (i) {
      var mp = Number(i.master_price) || 0;
      var bp = Number(i.base_price) || mp;
      var up = Number(i.unit_price) || 0;
      var qty = Number(i.qty) || 0;
      var discPct = mp > 0 ? ((mp - up) / mp) * 100 : 0;
      return {
        item_id: String(i.item_id), line_no: Number(i.line_no),
        product_code: String(i.product_code), product_name: String(i.product_name),
        source: String(i.source), qty: qty,
        unit_price: up, master_price: mp, base_price: bp, line_total: qty * up,
        need_sn: Util.isTrue(i.need_sn),
        sns: (function () {
          var d = (snPerItem_[String(i.item_id)] || [])
            .sort(function (a, b) { return a.seq - b.seq; });
          var q = Number(i.qty) || 0;
          var out = [];
          for (var u = 1; u <= q; u++) {
            var ada = d.filter(function (x) { return x.seq === u; })[0];
            out.push(ada ? ada.sn : '');
          }
          return out;
        })(),
        sn_filled_qty: Number(i.sn_filled_qty) || 0,
        sn_summary: String(i.sn_summary || ''),
        item_note: String(i.item_note || ''),
        prepared: Util.isTrue(i.prepared),
        disc_pct: Math.round(discPct * 10) / 10,
        needs_approval: discPct > maxDisc + 0.001
      };
    });

  return {
    header: {
      trx_id: String(trx.trx_id), trx_no: String(trx.trx_no || ''),
      trx_date: Util.dateStr(trx.trx_date),
      customer_id: String(trx.customer_id),
      cust_name: String(trx.cust_name_snap), cust_phone: Util.hp(trx.cust_phone_snap),
      cust_member: String(trx.cust_member_snap || ''),

      /*
       * Email diambil dari data customernya, bukan dari salinan di
       * transaksi — kolom itu memang tidak ada.
       *
       * Dipakai Admin saat mengirim nota atau faktur. Tanpa ini
       * dia harus membuka Data Customer di layar lain hanya untuk
       * menyalin satu alamat.
       */
      cust_email: (function () {
        if (!trx.customer_id) return '';
        try {
          var c = Repo.findOne(DB.SHEET.CUSTOMERS, 'customer_id', trx.customer_id);
          return c ? String(c.email || '') : '';
        } catch (eE) { return ''; }
      })(),

      sales_code: String(trx.sales_code || ''),
      sales_name: String(trx.sales_name || ''),
      sales_type: String(trx.sales_type || ''),
      sales_type_label: salesTypeLabel_(trx.sales_type),
      sales_user_id: String(trx.sales_user_id),
      input_by_name: String(trx.updated_by_name || ''),
      stage_status: String(trx.stage_status),
      stage_label: stageLabelCh_(trx.stage_status, trx.channel),
      payment_status: String(trx.payment_status),
      order_note: String(trx.order_note || ''),
      subtotal: Number(trx.subtotal) || 0,
      discount_total: Number(trx.discount_total) || 0,
      grand_total: Number(trx.grand_total) || 0,
      revision: Number(trx.revision) || 0,
      updated_at: Util.isoStr(trx.updated_at),
      updated_by_name: String(trx.updated_by_name || ''),
      confirmed_at: Util.isoStr(trx.sales_confirm_at),
      nota_no: String(trx.nota_no || ''),

      /*
       * Siapa yang boleh mengubah, bukan cuma tahap apa.
       *
       * Sales terkunci begitu nomor nota terbit — itu memang disengaja.
       * Tapi Admin dan Super Admin punya izin mengubah pada tahap mana
       * pun, dan justru merekalah yang menerima koreksi dari customer
       * di depan meja. Layar ini dulu hanya melihat tahapnya, sehingga
       * tombol ubah ikut hilang untuk orang yang sebenarnya berhak.
       */
      can_edit: hasPerm_(session, 'TRX_EDIT_ALL')
        ? ['SELESAI', 'DIBATALKAN'].indexOf(String(trx.stage_status)) < 0 &&
          !Util.isTrue(trx.is_void)
        : (['DRAFT', 'MENUNGGU_GUDANG', 'PROSES_GUDANG'].indexOf(String(trx.stage_status)) >= 0 ||
           (String(trx.stage_status) === 'SIAP_NOTA' && !String(trx.nota_no || '').trim())),

      // Peringatan khusus: mengubah setelah nota terbit tidak ikut
      // mengubah nota yang sudah tercetak di sistem kantor
      nota_terbit: !!String(trx.nota_no || '').trim(),
      // Perubahan barang fisik pada tahap ini akan mengembalikan
      // pesanan ke Gudang untuk disiapkan ulang
      peringatan_gudang: String(trx.stage_status) === 'SIAP_NOTA',
      revisi: (function () {
        var f = bacaFlags_(trx);
        return f.revisi || null;
      })()
    },
    items: items,
    maxDiscount: maxDisc,
    salesRequired: Util.isTrue(Settings.get('SALES_CODE_REQUIRED', 'TRUE'))
  };
}

function loadTrxForEdit_(session, trxId, expectedRevision) {
  var trx = Repo.findOne(DB.SHEET.TRX, 'trx_id', trxId);
  if (!trx) throw appErr_('NOT_FOUND', 'Transaksi tidak ditemukan.');
  if (Util.isTrue(trx.is_void)) throw appErr_('VOIDED', 'Transaksi ini sudah dibatalkan.');

  var isOwner = String(trx.sales_user_id) === String(session.user_id);
  if (!hasPerm_(session, 'TRX_EDIT_ALL') && !isOwner) {
    throw appErr_('FORBIDDEN', 'Pesanan ini dibuat dari akun lain.');
  }

  var stage = String(trx.stage_status);
  var adaNota = !!String(trx.nota_no || '').trim();

  // Sales boleh mengubah pesanannya selama nomor nota belum terbit.
  // Setelah nota resmi keluar, hanya Admin yang boleh — karena pada
  // titik itu notanya sudah tercatat di sistem kantor.
  var tahapTerbuka = ['DRAFT', 'MENUNGGU_GUDANG', 'PROSES_GUDANG'];
  if (!adaNota) tahapTerbuka.push('SIAP_NOTA');

  if (tahapTerbuka.indexOf(stage) < 0 && !hasPerm_(session, 'TRX_EDIT_ALL')) {
    throw appErr_('STAGE_LOCKED', adaNota
      ? 'Nomor nota sudah dibuat (' + trx.nota_no + '). Perubahan harus lewat Admin.'
      : 'Pesanan sudah pada tahap "' + stageLabel_(stage) + '". Hubungi Admin untuk perubahan.');
  }

  if (expectedRevision !== undefined && expectedRevision !== null && expectedRevision !== '') {
    if (Number(expectedRevision) !== (Number(trx.revision) || 0)) {
      throw appErr_('STALE_DATA',
        'Pesanan sudah diperbarui oleh ' + (trx.updated_by_name || 'orang lain') +
        '. Halaman dimuat ulang supaya Anda lihat versi terbaru.');
    }
  }
  return trx;
}

var _stageCache = null;
/**
 * Apakah pesanan ini perlu lewat Teknisi.
 *
 * Ritel NB selalu perlu — laptop hampir selalu butuh aktivasi, dan
 * itulah yang berjalan selama ini. Untuk pesanan online, Eksekusi
 * yang menentukan saat menyiapkan: beli mouse atau tinta tidak ada
 * yang perlu dikerjakan Teknisi.
 *
 * Kalau tidak ditentukan sama sekali, dianggap perlu. Lebih baik
 * satu pesanan lewat meja yang tidak perlu daripada barang keluar
 * tanpa dicek.
 */
function perluTeknisi_(trx) {
  var v = String(trx && trx.perlu_teknisi);
  if (v === 'false' || v === 'FALSE' || v === 'TIDAK') return false;
  return true;
}

/**
 * Nama tahap yang menyesuaikan saluran.
 *
 * Pesanan online disiapkan Tim Eksekusi, bukan Gudang — tapi
 * tahapannya sama, jadi tulisannya ikut "Menunggu Gudang". Sales
 * Online yang melihatnya jadi bingung: pesanannya tidak pernah masuk
 * Gudang.
 *
 * Yang diubah hanya tulisannya, bukan kodenya. Kode tetap satu,
 * jadi tidak ada logika yang perlu mengenali dua jenis tahap.
 */
function stageLabelCh_(code, channel) {
  var k = String(code);
  if (String(channel || '').toUpperCase() !== 'ONLINE') return stageLabel_(k);

  var ganti = {
    MENUNGGU_GUDANG: 'Menunggu Eksekusi',
    PROSES_GUDANG: 'Proses Eksekusi'
  };
  return ganti[k] || stageLabel_(k);
}

function stageLabel_(code) {
  if (!_stageCache) {
    _stageCache = {};
    Repo.columns(DB.SHEET.STATUS, ['status_code', 'label']).forEach(function (s) {
      _stageCache[String(s.status_code)] = String(s.label);
    });
  }
  return _stageCache[String(code)] || String(code);
}

/**
 * Mengembalikan pesanan ke Gudang.
 *
 * Dipakai saat barang fisiknya berubah setelah Gudang selesai —
 * ada tambahan, ada yang dibuang, atau jumlahnya berubah. Tanpa ini,
 * barang bisa tercetak di nota tapi tidak pernah benar-benar diambil
 * dari gudang, dan yang menanggung akibatnya customer di depan meja.
 */
function mundurKeGudang_(session, trx, alasan) {
  if (String(trx.stage_status) !== 'SIAP_NOTA') return false;

  Repo.update(DB.SHEET.TRX, trx._row, {
    stage_status: 'PROSES_GUDANG',
    gudang_confirm_at: ''
  });

  logAudit_(session, {
    entity: 'TRX', entity_id: trx.trx_id, trx_no: trx.trx_no,
    action: 'STAGE_CHANGE', field: 'stage_status',
    old_value: 'SIAP_NOTA', new_value: 'PROSES_GUDANG',
    reason: alasan
  });
  logTimeline_(session, {
    trx_id: trx.trx_id, trx_no: trx.trx_no,
    event_code: 'REOPEN_GUDANG', stage_after: 'PROSES_GUDANG',
    event_label: 'Pesanan dikembalikan ke Gudang karena isinya berubah',
    detail: alasan
  });
  pushNotif_({
    target_role: peranPenyiap_(trx), target_branch: trx.branch,
    trx_id: trx.trx_id, trx_no: trx.trx_no,
    type: 'ORDER_EDITED', priority: 'HIGH',
    title: 'Pesanan dibuka ulang',
    body: trx.trx_no + ' · ' + trx.cust_name_snap + ' · ' + alasan
  });
  pushNotif_({
    target_role: 'ADMIN', target_branch: trx.branch,
    trx_id: trx.trx_id, trx_no: trx.trx_no,
    type: 'ORDER_EDITED', priority: 'NORMAL',
    title: 'Pesanan kembali ke Gudang',
    body: trx.trx_no + ' · ' + alasan + ' · nota ditunda'
  });

  trx.stage_status = 'PROSES_GUDANG';
  return true;
}

function notifyEditAfterConfirm_(session, trx, ringkas) {
  var stage = String(trx.stage_status);
  if (stage === 'DRAFT') return;

  logTimeline_(session, {
    trx_id: trx.trx_id, trx_no: trx.trx_no,
    event_code: 'TRX_EDITED', stage_after: stage,
    event_label: 'Pesanan diperbarui oleh ' + session.full_name,
    detail: ringkas
  });

  if (stage === 'MENUNGGU_GUDANG' || stage === 'PROSES_GUDANG') {
    pushNotif_({
      target_role: peranPenyiap_(trx), target_branch: trx.branch,
      trx_id: trx.trx_id, trx_no: trx.trx_no,
      type: 'ORDER_EDITED', priority: 'HIGH',
      title: 'Pesanan diubah',
      body: trx.trx_no + ' · ' + trx.cust_name_snap + ' · ' + ringkas
    });
  } else if (stage === 'SIAP_NOTA' || stage === 'MENUNGGU_PEMBAYARAN') {
    // Barangnya tidak berubah, hanya angkanya — Admin cukup diberi tahu
    pushNotif_({
      target_role: 'ADMIN', target_branch: trx.branch,
      trx_id: trx.trx_id, trx_no: trx.trx_no,
      type: 'ORDER_EDITED', priority: 'NORMAL',
      title: 'Pesanan diubah',
      body: trx.trx_no + ' · ' + trx.cust_name_snap + ' · ' + ringkas
    });
  }
}

// ============================================================
// API — TRANSAKSI
// ============================================================

/**
 * Membuat baris transaksi baru dan mengembalikan trx_id-nya.
 *
 * Dipisah dari apiCreateDraft supaya bisa dipakai juga oleh konfirmasi
 * langsung — Sales yang membuat pesanan lalu langsung mengonfirmasi
 * tidak perlu dua perjalanan ke server untuk satu pekerjaan.
 */
/**
 * Menentukan saluran pesanan dari jenis salesnya.
 *
 * Kode sales sudah membawa keterangannya — SPW-O-NOFI itu online,
 * SPW-R-RIRIH itu ritel. Tapi disimpan sebagai kolom tersendiri
 * supaya gampang disaring dan dilaporkan, dan supaya penyaringan
 * antrian tidak perlu mengurai kode tiap kali.
 */
function saluranDariSales_(sales) {
  if (!sales) return 'RITEL';
  var t = String(sales.type || '').toUpperCase();
  if (t === 'O') return 'ONLINE';
  if (t === 'P') return 'PROMOTOR';
  return 'RITEL';
}

/**
 * Divisi mana yang menyiapkan barang untuk pesanan ini.
 *
 * Pesanan ritel disiapkan Gudang, pesanan online disiapkan Tim
 * Eksekusi. Pekerjaannya sama, antriannya berbeda — jadi yang perlu
 * ditentukan cuma ke mana pemberitahuannya dikirim.
 */
/**
 * Menyimpan keterangan khusus pesanan online.
 *
 * Dipakai tiga tempat: saat draft disimpan, saat dikonfirmasi, dan
 * saat pesanan yang sudah dikonfirmasi diubah.
 *
 * Dulu hanya saat konfirmasi. Akibatnya Sales yang mengubah cara
 * bayar setelah pesanan terkirim — customer tiba-tiba mau DP —
 * perubahannya tidak tersimpan di mana pun, dan resepnya tetap
 * mencetak keterangan yang lama.
 */
function simpanKeteranganOnline_(trx, payload) {
  if (String(trx.channel || '').toUpperCase() !== 'ONLINE') return false;

  var patch = {};
  var ada = false;

  ['sumber', 'gedung', 'metode_serah', 'cara_bayar'].forEach(function (k) {
    if (payload[k] === undefined || payload[k] === null) return;
    patch[k] = String(payload[k]).substring(0, 40);
    ada = true;
  });

  if (payload.faktur_pajak !== undefined) {
    patch.faktur_pajak = Util.isTrue(payload.faktur_pajak);
    ada = true;
  }

  if (payload.tempo_hari !== undefined) {
    var hari = Number(payload.tempo_hari) || 0;
    patch.tempo_hari = (hari > 0 && hari <= 180) ? hari : 0;
    ada = true;
  }

  if (payload.dp_info !== undefined) {
    patch.dp_info = Number(payload.dp_info) || 0;
    ada = true;
  }

  if (ada) Repo.tundaUpdate(DB.SHEET.TRX, trx._row, patch);
  return ada;
}

function peranPenyiap_(trx) {
  var ch = String(trx && trx.channel || '').toUpperCase();
  if (!ch) ch = saluranDariSales_(findSales_(trx && trx.sales_code));
  return ch === 'ONLINE' ? 'EKSEKUSI' : 'GUDANG';
}

/**
 * Kode sales yang berlaku untuk sesi ini.
 *
 * Akun milik satu orang sales memaksa namanya sendiri — bukan
 * karena tidak percaya, tapi karena memilih nama tiap transaksi
 * adalah pekerjaan yang tidak perlu, dan sekali salah pilih
 * komisinya masuk ke orang lain.
 *
 * Akun divisi yang dipakai bersama tetap memilih seperti biasa.
 */
function salesUntukSesi_(session, diminta) {
  var milik = String(session.sales_code || '').trim();
  return milik || String(diminta || '');
}

function buatTrxBaru_(session, customerId, salesCode) {
  salesCode = salesUntukSesi_(session, salesCode);
  var cust = null;
  if (customerId) {
    cust = Repo.findOne(DB.SHEET.CUSTOMERS, 'customer_id', customerId);
    if (!cust) throw appErr_('NO_CUSTOMER', 'Customer tidak ditemukan.');
  }

  var sales = findSales_(salesCode);
  var onConfirm = Util.isTrue(Settings.get('TRX_NO_ON_CONFIRM', 'FALSE'));
  var trxId = Util.id('TRX');
  var trxNo = onConfirm ? '' : generateTrxNo_(session.branch);
  var now = nowIso_();

  Repo.append(DB.SHEET.TRX, {
    trx_id: trxId, trx_no: trxNo, branch: session.branch, trx_date: Util.todayStr(),
    customer_id: cust ? cust.customer_id : '',
    cust_name_snap: cust ? cust.full_name : '',
    cust_phone_snap: cust ? cust.phone : '',
    cust_member_snap: cust ? cust.member_code : '',
    sales_user_id: session.user_id,
    sales_code: sales ? sales.code : '',
    sales_name: sales ? sales.name : '',
    sales_type: sales ? sales.type : '',
    channel: saluranDariSales_(sales),
    stage_status: 'DRAFT', payment_status: 'BELUM_BAYAR',
    order_note: '', item_count: 0,
    subtotal: 0, discount_total: 0, grand_total: 0, paid_total: 0, outstanding: 0,
    resep_print_count: 0, revision: 0,
    created_at: now, created_by: session.user_id,
    updated_at: now, updated_by: session.user_id, updated_by_name: session.full_name,
    is_void: false
  });

  logAudit_(session, {
    entity: 'TRX', entity_id: trxId, trx_no: trxNo, action: 'CREATE',
    new_value: (cust ? cust.full_name : '(customer menyusul)') +
      (sales ? ' / sales ' + sales.code : '')
  });
  logTimeline_(session, {
    trx_id: trxId, trx_no: trxNo, event_code: 'TRX_CREATE', stage_after: 'DRAFT',
    event_label: 'Pesanan dibuat' + (sales ? ' untuk sales ' + sales.name : ''),
    detail: 'Customer: ' + (cust ? cust.full_name : 'menyusul') +
      ' · diinput oleh ' + session.full_name
  });

  return trxId;
}

function apiCreateDraft(payload) {
  return withGuard_(payload, { permission: 'TRX_CREATE', lock: 'ringan' }, function (session) {
    var jam = Jam.mulai('apiCreateDraft');
    /*
     * Pesanan boleh dimulai tanpa customer.
     *
     * Di lapangan, customer sering masih mengisi form QR sementara
     * barangnya sudah bisa disiapkan. Menunggu datanya lengkap dulu
     * membuang waktu yang sebenarnya bisa dipakai bekerja.
     *
     * Yang dijaga: pesanan tanpa customer TIDAK BISA dikonfirmasi ke
     * Gudang. Jadi tidak mungkin ada barang keluar tanpa jelas untuk siapa.
     */
    var cust = null;
    if (payload.customer_id) {
      cust = Repo.findOne(DB.SHEET.CUSTOMERS, 'customer_id', payload.customer_id);
      if (!cust) throw appErr_('NO_CUSTOMER', 'Customer tidak ditemukan.');
    }

    var sales = findSales_(salesUntukSesi_(session, payload.sales_code));
    var onConfirm = Util.isTrue(Settings.get('TRX_NO_ON_CONFIRM', 'FALSE'));
    var trxId = Util.id('TRX');
    var trxNo = onConfirm ? '' : generateTrxNo_(session.branch);
    var now = nowIso_();

    Repo.append(DB.SHEET.TRX, {
      trx_id: trxId, trx_no: trxNo, branch: session.branch, trx_date: Util.todayStr(),
      customer_id: cust ? cust.customer_id : '',
      cust_name_snap: cust ? cust.full_name : '',
      cust_phone_snap: cust ? cust.phone : '',
      cust_member_snap: cust ? cust.member_code : '',
      sales_user_id: session.user_id,
      sales_code: sales ? sales.code : '',
      sales_name: sales ? sales.name : '',
      sales_type: sales ? sales.type : '',

      /*
       * Saluran ditentukan sejak draft dibuat.
       *
       * Sebelumnya baru diisi saat konfirmasi. Akibatnya draft milik
       * Sales Online tersimpan tanpa saluran, lalu disaring sebagai
       * pesanan ritel — dan hilang dari daftarnya sendiri. Orangnya
       * mengira draftnya gagal tersimpan, padahal ada.
       */
      channel: (String(session.role) === 'SALES_ONLINE')
        ? 'ONLINE' : saluranDariSales_(sales),

      stage_status: 'DRAFT', payment_status: 'BELUM_BAYAR',
      order_note: '', item_count: 0,
      subtotal: 0, discount_total: 0, grand_total: 0, paid_total: 0, outstanding: 0,
      resep_print_count: 0, revision: 0,
      created_at: now, created_by: session.user_id,
      updated_at: now, updated_by: session.user_id, updated_by_name: session.full_name,
      is_void: false
    });

    logAudit_(session, {
      entity: 'TRX', entity_id: trxId, trx_no: trxNo, action: 'CREATE',
      new_value: (cust ? cust.full_name : '(customer menyusul)') +
        (sales ? ' / sales ' + sales.code : '')
    });
    logTimeline_(session, {
      trx_id: trxId, trx_no: trxNo, event_code: 'TRX_CREATE', stage_after: 'DRAFT',
      event_label: 'Pesanan dibuat' + (sales ? ' untuk sales ' + sales.name : ''),
      detail: 'Customer: ' + (cust ? cust.full_name : 'menyusul') +
        ' · diinput oleh ' + session.full_name
    });

    jam.tandai('buat transaksi');

    /*
     * Transaksi yang baru dibuat isinya pasti kosong — tidak ada
     * barang, tidak ada SN, tidak ada pembayaran. Membacanya ulang
     * dari spreadsheet untuk memastikan itu memakan 1,7 detik untuk
     * jawaban yang sudah bisa dipastikan sejak awal.
     */
    var hasilDf = {
      header: {
        trx_id: trxId, trx_no: trxNo, trx_date: Util.todayStr(),
        customer_id: cust ? String(cust.customer_id) : '',
        cust_name: cust ? String(cust.full_name) : '',
        cust_phone: cust ? String(cust.phone) : '',
        cust_member: cust ? String(cust.member_code || '') : '',
        sales_code: sales ? sales.code : '',
        sales_name: sales ? sales.name : '',
        sales_type: sales ? sales.type : '',
        sales_type_label: sales ? salesTypeLabel_(sales.type) : '',
        stage_status: 'DRAFT', stage_label: stageLabel_('DRAFT'),
        payment_status: 'BELUM_BAYAR',
        order_note: '', item_count: 0,
        subtotal: 0, discount_total: 0, grand_total: 0,
        paid_total: 0, outstanding: 0, revision: 0,
        can_edit: true, nota_no: '', nota_indent: ''
      },
      items: [],
      maxDiscount: Number(Settings.num('MAX_DISCOUNT_PCT_SALES', 5)),
      salesRequired: Util.isTrue(Settings.get('SALES_CODE_REQUIRED', 'TRUE'))
    };

    jam.selesai();

    /*
     * Jawabannya dikembalikan.
     *
     * Ini yang membuat Simpan draft gagal dengan pesan "Cannot read
     * properties of null". Jawabannya dibangun lengkap lalu tidak
     * pernah dikirim — layar menerima kosong, dan baris berikutnya
     * membaca isinya.
     *
     * Terjadi saat saya memecah fungsi ini beberapa hari lalu.
     */
    return hasilDf;
  });
}

/** Mengganti sales pada pesanan yang sedang disusun */
function apiSetTrxSales(payload) {
  return withGuard_(payload, { permission: 'TRX_CREATE', lock: true }, function (session) {
    var trx = loadTrxForEdit_(session, payload.trx_id, payload.revision);
    var sales = findSales_(salesUntukSesi_(session, payload.sales_code));
    if (!sales) throw appErr_('NO_SALES', 'Kode sales tidak dikenal.');
    if (!sales.active) throw appErr_('INACTIVE_SALES', 'Kode sales itu sudah tidak aktif.');

    if (String(trx.sales_code) === sales.code) return buildTrxState_(session, trx.trx_id);

    var lama = String(trx.sales_code || '(kosong)');
    bumpRevision_(session, trx, {
      sales_code: sales.code, sales_name: sales.name, sales_type: sales.type
    });

    logAudit_(session, {
      entity: 'TRX', entity_id: trx.trx_id, trx_no: trx.trx_no,
      action: 'UPDATE', field: 'sales_code',
      old_value: lama, new_value: sales.code
    });
    notifyEditAfterConfirm_(session, trx, 'Sales diubah jadi ' + sales.name);

    return buildTrxState_(session, trx.trx_id);
  });
}

/**
 * Apakah akun ini boleh membuka rincian transaksi pada tahap itu.
 *
 * Selain Sales, semua boleh. Untuk Sales, tergantung pengaturan
 * SALES_LIHAT_SETELAH_KASIR yang hanya bisa diubah Super Admin.
 */
function bolehBukaSales_(session, tahap) {
  if (session.role !== 'SALES' || hasPerm_(session, 'TRX_VIEW_ALL')) return true;
  if (Util.isTrue(Settings.get('SALES_LIHAT_SETELAH_KASIR', 'FALSE'))) return true;

  return ['MENUNGGU_PEMBAYARAN', 'MENUNGGU_AKTIVASI', 'PROSES_AKTIVASI',
          'AKTIVASI_SELESAI', 'SELESAI'].indexOf(String(tahap)) < 0;
}

function apiGetTrx(payload) {
  return withGuard_(payload, {}, function (session) {
    var trx = Repo.findOne(DB.SHEET.TRX, 'trx_id', payload.trx_id);
    if (!trx) throw appErr_('NOT_FOUND', 'Transaksi tidak ditemukan.');

    var isOwner = String(trx.sales_user_id) === String(session.user_id);
    if (!hasPerm_(session, 'TRX_VIEW_ALL') && !hasPerm_(session, 'TRX_VIEW_STAGE') && !isOwner) {
      throw appErr_('FORBIDDEN', 'Anda tidak punya akses ke pesanan ini.');
    }

    /*
     * Sales dibatasi melihat rincian setelah transaksi lewat Kasir.
     *
     * Akun Sales dipakai bergantian, termasuk oleh promotor brand yang
     * menurut aturan perusahaan hanya boleh melihat penjualan brandnya
     * sendiri. Selama transaksi bisa dibuka kapan saja, seluruh isi
     * penjualan hari itu terbaca siapa pun yang memegang akunnya.
     *
     * Setelah masuk Kasir, Sales juga sudah tidak punya pekerjaan di
     * transaksi itu — koreksi nota pun lewat Admin. Jadi menutupnya
     * tidak menghambat apa pun.
     *
     * Bisa dibuka kembali lewat pengaturan SALES_LIHAT_SETELAH_KASIR,
     * dan hanya Super Admin yang bisa mengubahnya.
     */
    if (session.role === 'SALES' && !hasPerm_(session, 'TRX_VIEW_ALL')) {
      var bolehSelalu = Util.isTrue(Settings.get('SALES_LIHAT_SETELAH_KASIR', 'FALSE'));
      var tahap = String(trx.stage_status);
      var sudahLewat = ['MENUNGGU_PEMBAYARAN', 'MENUNGGU_AKTIVASI', 'PROSES_AKTIVASI',
                        'AKTIVASI_SELESAI', 'SELESAI'].indexOf(tahap) >= 0;

      if (!bolehSelalu && sudahLewat) {
        throw appErr_('SALES_LOCKED',
          'Pesanan ini sudah masuk tahap "' + stageLabel_(tahap) + '", jadi rinciannya ' +
          'tidak bisa dibuka lagi dari akun Sales. Kalau ada yang perlu dikoreksi, ' +
          'hubungi Admin.');
      }
    }

    return buildTrxState_(session, payload.trx_id);
  });
}

function apiMyTransactions(payload) {
  return withGuard_(payload, {}, function (session) {
    /*
     * Daftar ini dibaca dari sumbernya, bukan dari salinan.
     *
     * Ada kejadian nomor transaksi di daftar berbeda dengan nomor
     * yang muncul setelah dibuka — salinan blok datanya tidak lagi
     * sejajar dengan isi sheet, jadi nomor dari satu baris terpasang
     * pada keterangan baris lain.
     *
     * Daftar ini pendek dan jarang dibuka dibanding layar antrian,
     * jadi membacanya langsung tidak terasa lambat — dan jauh lebih
     * murah daripada orang meragukan seluruh angkanya.
     */
    try { Repo.bustSheet(DB.SHEET.TRX); } catch (e) {}

    var scope = String(payload.scope || 'today');
    var all = hasPerm_(session, 'TRX_VIEW_ALL');
    var today = Util.todayStr();

    var rows = Repo.columns(DB.SHEET.TRX, [
      'trx_id', 'trx_no', 'trx_date', 'cust_name_snap', 'cust_phone_snap',
      'sales_user_id', 'sales_name', 'sales_code', 'sales_type', 'stage_status', 'payment_status',
      'channel', 'sumber', 'metode_serah', 'tempo_hari', 'faktur_pajak',
      'eksekusi_pic_nama', 'gudang_petugas_nama', 'tech_petugas_nama',
      'serah_driver', 'serah_resi', 'kerja_teknisi', 'cara_bayar',
      'item_count', 'grand_total', 'created_at', 'updated_at', 'nota_no', 'is_void'
    ]);

    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var t = rows[i];
      if (Util.isTrue(t.is_void)) continue;
      /*
       * Akun sales perorangan tetap melihat pesanan divisinya.
       *
       * Sempat saya batasi ke pesanannya sendiri — keliru. Sales
       * saling menggantikan: yang membuat pesanan belum tentu yang
       * menjawab customernya setengah jam kemudian, dan daftar yang
       * hanya berisi pesanan sendiri membuat pertanyaan itu
       * menggantung.
       *
       * Omzet pribadinya tetap terpisah, dihitung dari kode
       * salesnya — bukan dari siapa yang mengetik.
       */
      var akunOrang = !!String(session.sales_code || '').trim();
      if (!all && !akunOrang &&
          String(t.sales_user_id) !== String(session.user_id)) continue;

      /*
       * Tiap divisi sales hanya melihat pesanannya sendiri.
       *
       * Akun dipakai bersama satu divisi, jadi penyaringnya saluran,
       * bukan orang. Sales NB tidak perlu memilah pesanan online di
       * daftarnya, dan sebaliknya.
       */
      /*
       * Draft yang belum punya saluran tidak disaring.
       *
       * Draft dibuat sebelum salurannya pasti — dan yang membuatnya
       * sudah jelas: orang yang sedang melihat daftarnya. Menyaring
       * berdasarkan tebakan membuat draftnya menghilang.
       */
      var chT = String(t.channel || '').toUpperCase();
      var draftKosong = (String(t.stage_status) === 'DRAFT' && !chT);

      if (!draftKosong) {
        if (!chT) chT = 'RITEL';
        if (String(session.role) === 'SALES_ONLINE' && chT !== 'ONLINE') continue;
        if (String(session.role) === 'SALES' && chT === 'ONLINE') continue;
      }

      /*
       * "Hari ini" dinilai dari tanggal transaksi ATAU tanggal
       * dibuatnya.
       *
       * Keduanya biasanya sama, tapi tidak selalu: pesanan indent yang
       * dibuat kemarin lalu barangnya datang hari ini, atau baris lama
       * yang tanggal transaksinya belum terisi. Kalau hanya satu yang
       * dipakai, transaksi seperti itu hilang dari daftar tanpa alasan
       * yang terlihat.
       */
      if (scope === 'today') {
        var tglTrx = Util.dateStr(t.trx_date);
        var tglBuat = Util.dateStr(t.created_at);
        if (tglTrx !== today && tglBuat !== today) continue;
      }

      /*
       * Rentang tanggal, kalau diminta.
       *
       * Dipakai untuk menelusuri pesanan lama tanpa harus tahu kata
       * kuncinya — "semua pesanan bulan lalu" lebih mudah daripada
       * mengingat nama customernya.
       */
      if (payload.dari || payload.sampai) {
        var tglP = Util.dateStr(t.trx_date) || Util.dateStr(t.created_at);
        if (payload.dari && tglP < String(payload.dari)) continue;
        if (payload.sampai && tglP > String(payload.sampai)) continue;
      }
      if (scope === 'draft' && String(t.stage_status) !== 'DRAFT') continue;
      if (scope === 'open' && ['SELESAI', 'DIBATALKAN'].indexOf(String(t.stage_status)) >= 0) continue;

      out.push({
        trx_id: String(t.trx_id), trx_no: String(t.trx_no || '(belum bernomor)'),

        // Tanggalnya ikut dikirim supaya layar bisa menyaring sendiri
        // kalau perlu, tanpa menebak dari nomor transaksi
        tanggal: Util.dateStr(t.trx_date) || Util.dateStr(t.created_at),

        cust_name: String(t.cust_name_snap), cust_phone: Util.hp(t.cust_phone_snap),
        sales_name: String(t.sales_name || ''), sales_code: String(t.sales_code || ''),
        sales_type_label: salesTypeLabel_(t.sales_type),
        stage_status: String(t.stage_status),
        stage_label: stageLabelCh_(t.stage_status, t.channel),
        payment_status: String(t.payment_status),
        item_count: Number(t.item_count) || 0,
        grand_total: Number(t.grand_total) || 0,
        nota_no: String(t.nota_no || ''),
        channel: String(t.channel || 'RITEL'),
        sumber: String(t.sumber || ''),
        metode_serah: String(t.metode_serah || ''),

        /*
         * Siapa yang sudah mengambil pesanan ini.
         *
         * Pesanan indent menunggu berhari-hari. Tanpa nama, Sales
         * yang ditanya customer tidak tahu harus menagih ke siapa.
         */
        penyiap: String(t.eksekusi_pic_nama || t.gudang_petugas_nama || ''),
        sudah_cetak: (Number(t.resep_print_count) || 0) > 0,
        tempo_hari: Number(t.tempo_hari) || 0,
        cara_bayar: String(t.cara_bayar || ''),
        faktur_pajak: Util.isTrue(t.faktur_pajak),

        /*
         * Siapa yang memegang dan siapa yang mengantar.
         *
         * Sales Online yang ditanyai customer, jadi dia yang perlu
         * bisa menjawab tanpa bertanya ke divisi lain dulu.
         */
        pic_nama: String(t.eksekusi_pic_nama || t.gudang_petugas_nama || ''),
        teknisi: String(t.tech_petugas_nama || ''),
        driver: String(t.serah_driver || ''),
        resi: String(t.serah_resi || ''),
        kerja_teknisi: String(t.kerja_teknisi || ''),
        bisa_buka: bolehBukaSales_(session, t.stage_status),
        bisa_edit: ['DRAFT', 'MENUNGGU_GUDANG', 'PROSES_GUDANG'].indexOf(String(t.stage_status)) >= 0 ||
                   (String(t.stage_status) === 'SIAP_NOTA' && !String(t.nota_no || '').trim()),
        created_at: Util.isoStr(t.created_at), updated_at: Util.isoStr(t.updated_at)
      });
    }
    return out.reverse().slice(0, 120);
  });
}

function apiUpdateTrxNote(payload) {
  return withGuard_(payload, { permission: 'TRX_CREATE', lock: true }, function (session) {
    var trx = loadTrxForEdit_(session, payload.trx_id, payload.revision);
    var note = String(payload.note || '').trim().substring(0, 500);
    if (note === String(trx.order_note).trim()) return buildTrxState_(session, trx.trx_id);

    var old = trx.order_note;
    bumpRevision_(session, trx, { order_note: note });

    logAudit_(session, {
      entity: 'TRX', entity_id: trx.trx_id, trx_no: trx.trx_no,
      action: 'UPDATE', field: 'order_note', old_value: old, new_value: note
    });
    notifyEditAfterConfirm_(session, trx, 'Keterangan pesanan diubah');
    return buildTrxState_(session, trx.trx_id);
  });
}

// ============================================================
// API — ITEM
// ============================================================

function apiAddItem(payload) {
  return withGuard_(payload, { permission: 'ITEM_ADD', lock: true }, function (session) {
    var trx = loadTrxForEdit_(session, payload.trx_id, payload.revision);
    var d = payload.item || {};
    var manual = String(d.source) === 'MANUAL';

    if (manual && !hasPerm_(session, 'ITEM_ADD_MANUAL')) {
      throw appErr_('FORBIDDEN', 'Anda tidak boleh menambah barang manual.');
    }

    var code = String(d.product_code || '').trim();
    var name = String(d.product_name || '').trim();
    var qty = Number(d.qty) || 0;
    var price, masterPrice, needSn;

    if (qty <= 0) throw appErr_('BAD_QTY', 'Jumlah harus lebih dari 0.');

    if (manual) {
      if (!name) throw appErr_('BAD_NAME', 'Nama barang manual wajib diisi.');
      if (!code) code = 'MANUAL';
      price = Number(d.unit_price) || 0;
      masterPrice = price;
      needSn = Util.isTrue(d.need_sn);
    } else {
      var p = null;
      var idx = getProductIndex_();
      for (var i = 0; i < idx.length; i++) { if (idx[i].k === code) { p = idx[i]; break; } }
      if (!p) throw appErr_('NO_PRODUCT', 'Barang "' + code + '" tidak ada di master. Pakai Tambah Barang Manual.');
      name = p.n;
      masterPrice = p.p;
      price = (d.unit_price === undefined || d.unit_price === '') ? p.p : Number(d.unit_price);
      needSn = p.sn;
    }

    /*
     * Harga minus diperbolehkan.
     *
     * Dipakai untuk baris potongan — voucher, promo, kompensasi.
     * Barangnya memang tidak ada, tapi angkanya nyata dan harus
     * ikut terhitung di nota.
     *
     * Dulu ditolak mentah-mentah, jadi potongan terpaksa dicatat
     * dengan mengubah harga barang lain — dan harga di nota tidak
     * lagi sesuai harga sebenarnya.
     *
     * Yang tetap dijaga: angkanya harus berupa angka, dan satu
     * baris potongan tidak boleh melebihi batas yang wajar.
     */
    if (isNaN(price)) throw appErr_('BAD_PRICE', 'Harganya bukan angka.');

    if (price < 0 && !hasPerm_(session, 'ITEM_EDIT_PRICE') &&
        !hasPerm_(session, 'ITEM_EDIT_PRICE_LIMITED')) {
      throw appErr_('FORBIDDEN', 'Anda tidak boleh memasukkan baris potongan.');
    }

    var existing = Repo.findManyFast(DB.SHEET.ITEMS, 'trx_id', trx.trx_id);
    var lineNo = existing.length + 1;
    var itemId = Util.id('ITM');
    var now = nowIso_();

    Repo.append(DB.SHEET.ITEMS, {
      item_id: itemId, trx_id: trx.trx_id, trx_no: trx.trx_no, line_no: lineNo,
      product_code: code, product_name: name, source: manual ? 'MANUAL' : 'MASTER',
      qty: qty, unit_price: price, master_price: masterPrice,
      base_price: Number(d.base_price) || masterPrice,
      line_total: qty * price,
      need_sn: needSn, sn_required_qty: needSn ? qty : 0, sn_filled_qty: 0,
      sn_summary: '', item_note: String(d.item_note || '').trim(),
      prepared: false, is_active: true,
      created_at: now, created_by: session.user_id,
      updated_at: now, updated_by: session.user_id
    });

    recalcTrx_(trx.trx_id);

    logAudit_(session, {
      entity: 'ITEM', entity_id: itemId, trx_no: trx.trx_no, action: 'CREATE',
      new_value: name + ' x' + qty + ' @' + price + (manual ? ' (manual)' : '')
    });

    // Barang bertambah berarti ada yang harus diambil lagi dari gudang
    var mundur = mundurKeGudang_(session, trx, 'Barang tambahan: ' + name + ' x' + qty);
    bumpRevision_(session, trx);

    if (!mundur) notifyEditAfterConfirm_(session, trx, 'Barang ditambah: ' + name + ' x' + qty);

    return buildTrxState_(session, trx.trx_id);
  });
}

function apiUpdateItem(payload) {
  return withGuard_(payload, { permission: 'ITEM_ADD', lock: true }, function (session) {
    var trx = loadTrxForEdit_(session, payload.trx_id, payload.revision);
    var it = Repo.findOne(DB.SHEET.ITEMS, 'item_id', payload.item_id);
    if (!it || String(it.trx_id) !== String(trx.trx_id)) {
      throw appErr_('NOT_FOUND', 'Barang tidak ditemukan di pesanan ini.');
    }
    if (!Util.isTrue(it.is_active)) throw appErr_('VOIDED', 'Barang ini sudah dibatalkan.');

    var patch = {}, changes = [];

    if (payload.qty !== undefined) {
      var qty = Number(payload.qty);
      if (!(qty > 0)) throw appErr_('BAD_QTY', 'Jumlah harus lebih dari 0.');
      if (qty !== Number(it.qty)) {
        patch.qty = qty;
        if (Util.isTrue(it.need_sn)) patch.sn_required_qty = qty;
        changes.push({ f: 'qty', a: it.qty, b: qty });
      }
    }

    if (payload.unit_price !== undefined) {
      var price = Number(payload.unit_price);
      if (isNaN(price)) throw appErr_('BAD_PRICE', 'Harganya bukan angka.');
      if (price !== Number(it.unit_price)) {
        if (!hasPerm_(session, 'ITEM_EDIT_PRICE') && !hasPerm_(session, 'ITEM_EDIT_PRICE_LIMITED')) {
          throw appErr_('FORBIDDEN', 'Anda tidak boleh mengubah harga.');
        }
        patch.unit_price = price;
        changes.push({ f: 'unit_price', a: it.unit_price, b: price });
      }
    }

    /*
     * Harga jual dasar — harga sebelum diskon.
     *
     * Berbeda dari harga master, yang tetap sebagai acuan katalog.
     * Sales sering menaikkannya karena ada tambahan seperti Office,
     * dan diskon harus memotong dari harga itu, bukan dari katalog.
     */
    if (payload.base_price !== undefined) {
      var bp = Number(payload.base_price);
      if (isNaN(bp)) throw appErr_('BAD_PRICE', 'Harga jualnya bukan angka.');
      if (bp !== Number(it.base_price || it.master_price)) {
        if (!hasPerm_(session, 'ITEM_EDIT_PRICE') && !hasPerm_(session, 'ITEM_EDIT_PRICE_LIMITED')) {
          throw appErr_('FORBIDDEN', 'Anda tidak boleh mengubah harga.');
        }
        patch.base_price = bp;
        changes.push({ f: 'base_price', a: it.base_price || it.master_price, b: bp });
      }
    }

    if (payload.item_note !== undefined) {
      var note = String(payload.item_note).trim().substring(0, 200);
      if (note !== String(it.item_note).trim()) {
        patch.item_note = note;
        changes.push({ f: 'item_note', a: it.item_note, b: note });
      }
    }

    if (!changes.length) return buildTrxState_(session, trx.trx_id);

    var finalQty = patch.qty !== undefined ? patch.qty : Number(it.qty);
    var finalPrice = patch.unit_price !== undefined ? patch.unit_price : Number(it.unit_price);
    patch.line_total = finalQty * finalPrice;
    patch.updated_at = nowIso_();
    patch.updated_by = session.user_id;

    if (Util.isTrue(it.prepared) && patch.qty !== undefined) {
      patch.prepared = false;
      patch.prepared_by = '';
      patch.prepared_at = '';
    }

    Repo.update(DB.SHEET.ITEMS, it._row, patch);
    recalcTrx_(trx.trx_id);

    changes.forEach(function (c) {
      logAudit_(session, {
        entity: 'ITEM', entity_id: it.item_id, trx_no: trx.trx_no, action: 'UPDATE',
        field: c.f, old_value: c.a, new_value: c.b, reason: payload.reason || ''
      });
    });

    var ringkas = it.product_name + ': ' +
      changes.map(function (c) { return c.f + ' ' + c.a + '→' + c.b; }).join(', ');

    // Jumlah berubah berarti barang fisiknya harus dihitung ulang.
    // Harga atau keterangan berubah tidak menyentuh barangnya.
    var mundur2 = false;
    if (patch.qty !== undefined) {
      mundur2 = mundurKeGudang_(session, trx,
        it.product_name + ': jumlah ' + changes.filter(function (c) { return c.f === 'qty'; })
          .map(function (c) { return c.a + ' → ' + c.b; }).join(''));
    }

    bumpRevision_(session, trx);
    if (!mundur2) notifyEditAfterConfirm_(session, trx, ringkas);

    return buildTrxState_(session, trx.trx_id);
  });
}

function apiVoidItem(payload) {
  return withGuard_(payload, { permission: 'ITEM_VOID', lock: true }, function (session) {
    var trx = loadTrxForEdit_(session, payload.trx_id, payload.revision);
    var it = Repo.findOne(DB.SHEET.ITEMS, 'item_id', payload.item_id);
    if (!it || String(it.trx_id) !== String(trx.trx_id)) {
      throw appErr_('NOT_FOUND', 'Barang tidak ditemukan di pesanan ini.');
    }

    Repo.update(DB.SHEET.ITEMS, it._row, {
      is_active: false,
      void_reason: String(payload.reason || '').trim(),
      updated_at: nowIso_(), updated_by: session.user_id
    });

    recalcTrx_(trx.trx_id);

    logAudit_(session, {
      entity: 'ITEM', entity_id: it.item_id, trx_no: trx.trx_no, action: 'VOID',
      old_value: it.product_name + ' x' + it.qty, new_value: '(dibatalkan)',
      reason: payload.reason || ''
    });

    // Barang dibuang berarti Gudang harus mengembalikannya ke rak
    var mundur3 = mundurKeGudang_(session, trx, 'Barang dibatalkan: ' + it.product_name);
    bumpRevision_(session, trx);

    if (!mundur3) notifyEditAfterConfirm_(session, trx, 'Barang dibatalkan: ' + it.product_name);

    return buildTrxState_(session, trx.trx_id);
  });
}

// ============================================================
// PENYIMPANAN ITEM BORONGAN (dipakai saat pesanan masih draft)
// ============================================================

/**
 * Menyimpan seluruh isi pesanan sekaligus.
 *
 * daftar = susunan barang yang diinginkan Sales saat ini.
 *   item_id berawalan "tmp-" berarti barang baru.
 * dihapus = daftar {item_id, reason} untuk barang yang dibuang.
 *
 * Barang yang ada di database tapi tidak ada di daftar akan
 * dinonaktifkan — bukan dihapus, jadi riwayatnya tetap utuh.
 */
function simpanItemsBorongan_(session, trx, daftar, dihapus) {
  daftar = daftar || [];
  dihapus = dihapus || [];

  var adaSekarang = Repo.findManyFast(DB.SHEET.ITEMS, 'trx_id', trx.trx_id);
  var petaLama = {};
  adaSekarang.forEach(function (i) { petaLama[String(i.item_id)] = i; });

  var alasanHapus = {};
  dihapus.forEach(function (d) { alasanHapus[String(d.item_id)] = String(d.reason || ''); });

  var now = nowIso_();
  var tetap = {};
  var baris = [];
  var n = 0;

  // 1. Barang yang bertahan: tambah baru atau perbarui yang sudah ada
  daftar.forEach(function (d, urut) {
    var qty = Number(d.qty) || 0;
    var harga = Number(d.unit_price) || 0;
    if (qty <= 0) throw appErr_('BAD_QTY', (d.product_name || 'Barang') + ': jumlah harus lebih dari 0.');

    /*
     * Harga minus diperbolehkan — ini baris potongan.
     *
     * Voucher, promo, atau kompensasi dicatat sebagai barisnya
     * sendiri dengan nilai minus, supaya harga barang aslinya tetap
     * apa adanya di nota.
     *
     * Inilah yang membuat voucher tidak bisa disimpan: pemeriksaan
     * ini menolaknya sebelum sempat tersimpan.
     */
    if (isNaN(harga)) {
      throw appErr_('BAD_PRICE', (d.product_name || 'Barang') + ': harganya bukan angka.');
    }

    var id = String(d.item_id || '');
    var lama = petaLama[id];

    if (lama) {
      tetap[id] = true;
      var patch = {}, ubah = [];

      if (qty !== Number(lama.qty)) { patch.qty = qty; ubah.push({ f: 'qty', a: lama.qty, b: qty }); }
      if (harga !== Number(lama.unit_price)) {
        patch.unit_price = harga; ubah.push({ f: 'unit_price', a: lama.unit_price, b: harga });
      }
      var hargaDasar = Number(d.base_price) || Number(lama.base_price) || Number(lama.master_price);
      if (hargaDasar !== Number(lama.base_price || lama.master_price)) {
        patch.base_price = hargaDasar;
        ubah.push({ f: 'base_price', a: lama.base_price || lama.master_price, b: hargaDasar });
      }
      var cat = String(d.item_note || '').trim().substring(0, 200);
      if (cat !== String(lama.item_note || '').trim()) {
        patch.item_note = cat; ubah.push({ f: 'item_note', a: lama.item_note, b: cat });
      }
      if (Number(lama.line_no) !== urut + 1) patch.line_no = urut + 1;

      if (ubah.length || patch.line_no !== undefined) {
        patch.line_total = qty * harga;
        if (Util.isTrue(lama.need_sn)) patch.sn_required_qty = qty;
        patch.updated_at = now;
        patch.updated_by = session.user_id;
        Repo.update(DB.SHEET.ITEMS, lama._row, patch);
        n += ubah.length;

        ubah.forEach(function (c) {
          logAudit_(session, {
            entity: 'ITEM', entity_id: id, trx_no: trx.trx_no, action: 'UPDATE',
            field: c.f, old_value: c.a, new_value: c.b
          });
        });
      }
      return;
    }

    // Barang baru
    var manual = String(d.source) === 'MANUAL';
    var kode = String(d.product_code || '').trim();
    var nama = String(d.product_name || '').trim();
    var hargaMaster, perluSn;

    if (manual) {
      if (!hasPerm_(session, 'ITEM_ADD_MANUAL')) {
        throw appErr_('FORBIDDEN', 'Anda tidak boleh menambah barang manual.');
      }
      if (!nama) throw appErr_('BAD_NAME', 'Nama barang manual wajib diisi.');
      if (!kode) kode = 'MANUAL';
      hargaMaster = Number(d.master_price) || harga;
      perluSn = Util.isTrue(d.need_sn);
    } else {
      var p = null;
      var idx = getProductIndex_();
      for (var k = 0; k < idx.length; k++) { if (idx[k].k === kode) { p = idx[k]; break; } }
      if (!p) throw appErr_('NO_PRODUCT', 'Barang "' + kode + '" tidak ada di master. Pakai Tambah Barang Manual.');
      nama = p.n;
      hargaMaster = p.p;
      perluSn = p.sn;
    }

    var idBaru = Util.id('ITM');
    baris.push({
      item_id: idBaru, trx_id: trx.trx_id, trx_no: trx.trx_no, line_no: urut + 1,
      product_code: kode, product_name: nama, source: manual ? 'MANUAL' : 'MASTER',
      qty: qty, unit_price: harga, master_price: hargaMaster,
      base_price: Number(d.base_price) || hargaMaster,
      line_total: qty * harga,
      need_sn: perluSn, sn_required_qty: perluSn ? qty : 0, sn_filled_qty: 0,
      sn_summary: '', item_note: String(d.item_note || '').trim(),
      prepared: false, is_active: true,
      created_at: now, created_by: session.user_id,
      updated_at: now, updated_by: session.user_id
    });

    logAudit_(session, {
      entity: 'ITEM', entity_id: idBaru, trx_no: trx.trx_no, action: 'CREATE',
      new_value: nama + ' x' + qty + ' @' + harga + (manual ? ' (manual)' : '')
    });
    n++;
  });

  if (baris.length) Repo.appendMany(DB.SHEET.ITEMS, baris);

  // 2. Barang yang dibuang: dinonaktifkan, tidak dihapus
  adaSekarang.forEach(function (i) {
    var id = String(i.item_id);
    if (tetap[id]) return;
    if (!Util.isTrue(i.is_active)) return;

    Repo.update(DB.SHEET.ITEMS, i._row, {
      is_active: false,
      void_reason: alasanHapus[id] || '',
      updated_at: now, updated_by: session.user_id
    });
    logAudit_(session, {
      entity: 'ITEM', entity_id: id, trx_no: trx.trx_no, action: 'VOID',
      old_value: i.product_name + ' x' + i.qty, new_value: '(dibatalkan)',
      reason: alasanHapus[id] || ''
    });
    n++;
  });

  return n;
}

/**
 * Menyimpan isi pesanan tanpa meneruskannya ke Gudang.
 * Dipakai tombol Simpan Draft, supaya pesanan bisa dilanjutkan
 * dari komputer lain.
 */
function apiSaveDraftItems(payload) {
  return withGuard_(payload, { permission: 'TRX_CREATE', lock: true }, function (session) {
    var trx = loadTrxForEdit_(session, payload.trx_id, payload.revision);

    if (String(trx.stage_status) !== 'DRAFT') {
      throw appErr_('NOT_DRAFT', 'Pesanan ini sudah dikonfirmasi, jadi perubahan langsung tersimpan.');
    }

    var patch = {};

    if (payload.sales_code !== undefined) {
      var sales = findSales_(salesUntukSesi_(session, payload.sales_code));
      if (sales) {
        patch.sales_code = sales.code;
        patch.sales_name = sales.name;
        patch.sales_type = sales.type;
      }
    }
    if (payload.note !== undefined) {
      patch.order_note = String(payload.note || '').trim().substring(0, 500);
    }

    simpanKeteranganOnline_(trx, payload);
    simpanItemsBorongan_(session, trx, payload.items, payload.voided);
    recalcTrx_(trx.trx_id);
    bumpRevision_(session, trx, patch);

    return buildTrxState_(session, trx.trx_id);
  });
}


// ============================================================
// MEMASANG CUSTOMER PADA PESANAN YANG SUDAH DIMULAI
// ============================================================

function apiSetTrxCustomer(payload) {
  return withGuard_(payload, { permission: 'TRX_CREATE', lock: 'ringan' }, function (session) {
    /*
     * Admin boleh mengganti customer pada tahap mana pun.
     *
     * Kejadian nyata: Sales salah memilih nama, dan baru ketahuan
     * setelah pesanan diteruskan ke Gudang. Kalau hanya bisa diubah
     * selagi draft, satu-satunya jalan adalah membatalkan lalu membuat
     * ulang — nomor berubah, riwayat terputus, dan nota yang sudah
     * terbit jadi tidak cocok dengan apa pun.
     *
     * Sales tetap dibatasi oleh aturan tahap yang biasa.
     */
    var trx;
    if (hasPerm_(session, 'TRX_EDIT_ALL')) {
      trx = Repo.findOne(DB.SHEET.TRX, 'trx_id', payload.trx_id);
      if (!trx) throw appErr_('NOT_FOUND', 'Transaksi tidak ditemukan.');
      if (Util.isTrue(trx.is_void)) throw appErr_('VOIDED', 'Transaksi ini sudah dibatalkan.');
      if (String(trx.stage_status) === 'SELESAI') {
        throw appErr_('STAGE_LOCKED',
          'Transaksi sudah selesai dan barangnya sudah diserahkan. ' +
          'Nama customer tidak bisa diubah lagi.');
      }
    } else {
      trx = loadTrxForEdit_(session, payload.trx_id, payload.revision);
    }

    var cust = Repo.findOne(DB.SHEET.CUSTOMERS, 'customer_id', payload.customer_id);
    if (!cust) throw appErr_('NO_CUSTOMER', 'Customer tidak ditemukan.');

    var lama = String(trx.cust_name_snap || '(kosong)');

    bumpRevision_(session, trx, {
      customer_id: cust.customer_id,
      cust_name_snap: cust.full_name,
      cust_phone_snap: cust.phone,
      cust_member_snap: cust.member_code || ''
    });

    logAudit_(session, {
      entity: 'TRX', entity_id: trx.trx_id, trx_no: trx.trx_no,
      action: 'UPDATE', field: 'customer',
      old_value: lama, new_value: cust.full_name + ' · ' + cust.phone
    });
    logTimeline_(session, {
      trx_id: trx.trx_id, trx_no: trx.trx_no,
      event_code: 'CUSTOMER_SET', stage_after: String(trx.stage_status),
      event_label: session.full_name +
        (lama === '(kosong)' ? ' memasang data customer' : ' mengganti customer'),
      detail: (lama === '(kosong)' ? '' : lama + ' → ') + cust.full_name + ' · ' + cust.phone
    });

    // Divisi yang sedang memegang pesanan perlu tahu namanya berubah
    if (lama !== '(kosong)' &&
        ['DRAFT'].indexOf(String(trx.stage_status)) < 0) {
      var tujuan = { MENUNGGU_GUDANG: 'GUDANG', PROSES_GUDANG: 'GUDANG',
                     SIAP_NOTA: 'ADMIN', MENUNGGU_PEMBAYARAN: 'KASIR',
                     MENUNGGU_AKTIVASI: 'TEKNISI', PROSES_AKTIVASI: 'TEKNISI'
                   }[String(trx.stage_status)];
      if (tujuan) {
        pushNotif_({
          target_role: tujuan, target_branch: trx.branch,
          trx_id: trx.trx_id, trx_no: trx.trx_no,
          type: 'ORDER_REVISED', priority: 'HIGH',
          title: 'Nama customer diubah',
          body: trx.trx_no + ' · ' + lama + ' → ' + cust.full_name
        });
      }
    }

    return buildTrxState_(session, trx.trx_id);
  });
}

// ============================================================
// REVISI PESANAN YANG SUDAH DIKONFIRMASI
// ============================================================

function bacaFlags_(trx) {
  var teks = String(trx.override_flags || '').trim();
  if (!teks) return {};
  try { return JSON.parse(teks); } catch (e) { return {}; }
}

/**
 * Mengirim seluruh perubahan pesanan sekaligus.
 *
 * Sales menyusun perubahannya di layar, lalu menekan satu tombol.
 * Divisi berikutnya menerima satu pemberitahuan, bukan satu per
 * setiap kotak yang diubah.
 *
 * Perubahan barang fisik (tambah, hapus, qty) mengembalikan pesanan
 * ke Gudang. Perubahan harga atau keterangan tidak.
 */
function apiReviseOrder(payload) {
  return withGuard_(payload, { permission: 'ITEM_ADD', lock: 'ringan' }, function (session) {
    var trx = loadTrxForEdit_(session, payload.trx_id, payload.revision);

    if (String(trx.stage_status) === 'DRAFT') {
      throw appErr_('IS_DRAFT', 'Pesanan ini masih draft. Pakai tombol Konfirmasi pesanan.');
    }

    // Foto keadaan sebelum diubah, untuk tahu apa yang benar-benar berubah
    var sebelum = {};
    Repo.findManyFast(DB.SHEET.ITEMS, 'trx_id', trx.trx_id)
      .filter(function (i) { return Util.isTrue(i.is_active); })
      .forEach(function (i) {
        sebelum[String(i.item_id)] = { qty: Number(i.qty) || 0, nama: String(i.product_name) };
      });

    var patch = {};
    if (payload.sales_code !== undefined) {
      var sales = findSales_(salesUntukSesi_(session, payload.sales_code));
      if (sales) {
        patch.sales_code = sales.code;
        patch.sales_name = sales.name;
        patch.sales_type = sales.type;
      }
    }
    if (payload.note !== undefined) {
      patch.order_note = String(payload.note || '').trim().substring(0, 500);
    }

    simpanKeteranganOnline_(trx, payload);
    simpanItemsBorongan_(session, trx, payload.items, payload.voided);
    recalcTrx_(trx.trx_id);

    // Bandingkan dengan keadaan sesudahnya
    var sesudah = {};
    Repo.findManyFast(DB.SHEET.ITEMS, 'trx_id', trx.trx_id)
      .filter(function (i) { return Util.isTrue(i.is_active); })
      .forEach(function (i) {
        sesudah[String(i.item_id)] = { qty: Number(i.qty) || 0, nama: String(i.product_name) };
      });

    var tambah = [], hapus = [], ubahQty = [];
    Object.keys(sesudah).forEach(function (id) {
      if (!sebelum[id]) { tambah.push(sesudah[id].nama + ' x' + sesudah[id].qty); return; }
      if (sebelum[id].qty !== sesudah[id].qty) {
        ubahQty.push(sesudah[id].nama + ' ' + sebelum[id].qty + '→' + sesudah[id].qty);
      }
    });
    Object.keys(sebelum).forEach(function (id) {
      if (!sesudah[id]) hapus.push(sebelum[id].nama);
    });

    var bagian = [];
    if (tambah.length) bagian.push('tambah ' + tambah.join(', '));
    if (hapus.length) bagian.push('hapus ' + hapus.join(', '));
    if (ubahQty.length) bagian.push('jumlah ' + ubahQty.join(', '));

    var fisikBerubah = bagian.length > 0;
    var ringkas = bagian.join(' · ') || 'Harga, diskon, atau keterangan diperbarui';

    var stageLama = String(trx.stage_status);
    var mundur = fisikBerubah && stageLama === 'SIAP_NOTA';

    if (mundur) {
      patch.stage_status = 'PROSES_GUDANG';
      patch.gudang_confirm_at = '';
      logAudit_(session, {
        entity: 'TRX', entity_id: trx.trx_id, trx_no: trx.trx_no,
        action: 'STAGE_CHANGE', field: 'stage_status',
        old_value: 'SIAP_NOTA', new_value: 'PROSES_GUDANG', reason: ringkas
      });
    }

    // Penanda revisi, supaya Gudang tahu ini bukan pesanan baru
    var flags = bacaFlags_(trx);
    flags.revisi = {
      at: nowIso_(), by: session.full_name,
      ringkas: ringkas, fisik: fisikBerubah, dibaca: false
    };
    patch.override_flags = JSON.stringify(flags);

    bumpRevision_(session, trx, patch);

    logTimeline_(session, {
      trx_id: trx.trx_id, trx_no: trx.trx_no,
      event_code: 'ORDER_REVISED',
      stage_after: mundur ? 'PROSES_GUDANG' : stageLama,
      event_label: 'Pesanan diubah oleh ' + session.full_name +
        (mundur ? ' · dikembalikan ke Gudang' : ''),
      detail: ringkas
    });

    // Satu pemberitahuan saja, ke divisi yang sedang memegang pesanan
    var stageBaru = mundur ? 'PROSES_GUDANG' : stageLama;
    if (['MENUNGGU_GUDANG', 'PROSES_GUDANG'].indexOf(stageBaru) >= 0) {
      pushNotif_({
        target_role: peranPenyiap_(trx), target_branch: trx.branch,
        trx_id: trx.trx_id, trx_no: trx.trx_no,
        type: 'ORDER_REVISED', priority: 'HIGH',
        title: fisikBerubah ? 'Pesanan diubah, cek ulang barangnya' : 'Keterangan pesanan diubah',
        body: trx.trx_no + ' · ' + trx.cust_name_snap + ' · ' + ringkas
      });
      if (mundur) {
        pushNotif_({
          target_role: 'ADMIN', target_branch: trx.branch,
          trx_id: trx.trx_id, trx_no: trx.trx_no,
          type: 'ORDER_REVISED', priority: 'NORMAL',
          title: 'Pesanan kembali ke Gudang',
          body: trx.trx_no + ' · ' + ringkas + ' · nota ditunda'
        });
      }
    } else {
      pushNotif_({
        target_role: 'ADMIN', target_branch: trx.branch,
        trx_id: trx.trx_id, trx_no: trx.trx_no,
        type: 'ORDER_REVISED', priority: 'NORMAL',
        title: 'Pesanan diubah',
        body: trx.trx_no + ' · ' + trx.cust_name_snap + ' · ' + ringkas
      });
    }

    return buildTrxState_(session, trx.trx_id);
  });
}

// ============================================================
// API — KONFIRMASI SALES
// ============================================================

function apiConfirmSales(payload) {
  return withGuard_(payload, { permission: 'TRX_CONFIRM_SALES', lock: 'ringan' }, function (session) {
    var jam = Jam.mulai('apiConfirmSales');

    /*
     * Transaksinya dibuat di sini kalau belum ada.
     *
     * Sebelumnya Sales harus menunggu satu perjalanan ke server untuk
     * membuat transaksi, baru perjalanan kedua untuk mengonfirmasi.
     * Yang pertama memakan hampir tujuh detik, dan selama itu layar
     * tertahan — jadi penyimpanan di latar belakang tidak terasa sama
     * sekali, karena yang lama justru terjadi sebelum itu dimulai.
     *
     * Sekarang keduanya satu panggilan.
     */
    if (!payload.trx_id) {
      payload.trx_id = buatTrxBaru_(session, payload.customer_id, payload.sales_code);
      payload.revision = 0;
      jam.tandai('buat transaksi');
    }
    var trx = loadTrxForEdit_(session, payload.trx_id, payload.revision);

    if (String(trx.stage_status) !== 'DRAFT') {
      throw appErr_('ALREADY', 'Pesanan ini sudah dikonfirmasi sebelumnya.');
    }

    // Tanpa customer, barang tidak boleh keluar ke Gudang
    if (!String(trx.customer_id || '').trim()) {
      throw appErr_('NO_CUSTOMER',
        'Data customer belum diisi. Cari dan pilih customernya dulu di atas, ' +
        'baru pesanan ini bisa diteruskan.');
    }

    // Seluruh isi pesanan disimpan di sini, sekali jalan.
    // Sales menyusun pesanan di layar, servernya baru bekerja saat ini.
    var patchAwal = {};

    if (payload.sales_code !== undefined || session.sales_code) {
      var salesPilih = findSales_(salesUntukSesi_(session, payload.sales_code));
      if (salesPilih) {
        patchAwal.sales_code = salesPilih.code;
        patchAwal.sales_name = salesPilih.name;
        patchAwal.sales_type = salesPilih.type;
        trx.sales_code = salesPilih.code;
        trx.sales_name = salesPilih.name;
      }
    }
    if (payload.note !== undefined) {
      patchAwal.order_note = String(payload.note || '').trim().substring(0, 500);
    }

    if (payload.items) {
      jam.tandai('baca transaksi');
      simpanItemsBorongan_(session, trx, payload.items, payload.voided);
      jam.tandai('simpan barang');
    }

    // Sales wajib dipilih, supaya penjualan bisa dihitung per orang
    var wajibSales = Util.isTrue(Settings.get('SALES_CODE_REQUIRED', 'TRUE'));
    if (wajibSales && getSalesList_().length && !String(trx.sales_code).trim()) {
      throw appErr_('NO_SALES', 'Pilih sales dulu sebelum pesanan diteruskan ke Gudang.');
    }

    var items = Repo.findManyFast(DB.SHEET.ITEMS, 'trx_id', trx.trx_id)
                    .filter(function (i) { return Util.isTrue(i.is_active); });

    if (!items.length) throw appErr_('NO_ITEM', 'Belum ada barang. Tambahkan minimal satu barang dulu.');

    var salah = [];
    items.forEach(function (i) {
      if (!(Number(i.qty) > 0)) salah.push(i.product_name + ': jumlah harus lebih dari 0');
      if (Number(i.unit_price) < 0) salah.push(i.product_name + ': harga minus');
    });
    if (salah.length) throw appErr_('BAD_ITEMS', salah.join(' · '));

    var hitung = recalcTrx_(trx.trx_id, trx);
    jam.tandai('hitung total');

    var now = nowIso_();
    var trxNo = trx.trx_no;
    if (!trxNo) {
      trxNo = generateTrxNo_(trx.branch);

      /*
       * Nomor transaksi ditulis ke semua barang sekaligus.
       *
       * Dulu satu penulisan untuk tiap barang. Pesanan berisi enam
       * barang berarti enam perjalanan ke spreadsheet, masing-masing
       * beberapa ratus milidetik — ongkos yang sebenarnya cukup
       * dibayar sekali.
       */
      var barisItem = Repo.findManyFast(DB.SHEET.ITEMS, 'trx_id', trx.trx_id)
        .map(function (i) { return i._row; });
      Repo.setKolom(DB.SHEET.ITEMS, barisItem, 'trx_no', trxNo);
    }
    jam.tandai('ambil nomor transaksi');

    /*
     * Pesanan indent tidak masuk antrian Gudang.
     *
     * Barangnya memang belum ada, jadi Gudang tidak bisa berbuat apa-apa.
     * Kalau tetap dimasukkan, alarmnya berbunyi terus dan Gudang dikira
     * tidak merespons — padahal yang ditunggu barangnya, bukan orangnya.
     *
     * Pesanan ini menunggu di daftarnya sendiri sampai ada yang menekan
     * "Barang sudah datang".
     */
    var indent = Util.isTrue(payload.indent);
    var tahapBaru = indent ? 'MENUNGGU_BARANG' : 'MENUNGGU_GUDANG';

    patchAwal.trx_no = trxNo;
    patchAwal.stage_status = tahapBaru;
    patchAwal.sales_confirm_by = session.user_id;
    patchAwal.sales_confirm_at = now;
    if (indent) patchAwal.indent_note = String(payload.indent_note || '').substring(0, 250);
    bumpRevision_(session, trx, patchAwal);

    jam.tandai('ubah tahap');

    /*
     * Keterangan khusus pesanan online.
     *
     * Asal pesanan dan cara barang sampai ke customer hanya ada pada
     * pesanan online. Di ritel keduanya selalu sama — datang ke toko
     * dan ambil sendiri — jadi tidak perlu ditanyakan.
     */
    /*
     * Keterangan khusus pesanan online.
     *
     * Saluran ditentukan dua arah: dari layar yang dipakai, dan dari
     * jenis kode salesnya. Layar yang dipakai didahulukan — kalau
     * seseorang membuka menu Pesanan Online, maksudnya memang online,
     * apa pun kode sales yang kebetulan terpilih.
     */
    var salesKini = findSales_(trx.sales_code);

    /*
     * Saluran ditentukan tiga arah, dengan urutan ini:
     *
     *   1. Peran yang membuat — akun Sales Online selalu online,
     *      apa pun kode sales yang kebetulan terpilih.
     *   2. Layar yang dipakai — menu Pesanan Online milik Super Admin.
     *   3. Jenis kode salesnya.
     *
     * Peran didahulukan karena itu yang paling tidak mungkin keliru:
     * orangnya memang bekerja di divisi itu.
     */
    var saluran = (String(session.role) === 'SALES_ONLINE' || Util.isTrue(payload.online))
      ? 'ONLINE' : saluranDariSales_(salesKini);

    Repo.tundaUpdate(DB.SHEET.TRX, trx._row, { channel: saluran });
    trx.channel = saluran;
    simpanKeteranganOnline_(trx, payload);

    /*
     * Tidak membaca ulang seluruh transaksi.
     *
     * Dari pengukuran, pembacaan ulang ini memakan 1,3 detik — hampir
     * sepertiga waktu konfirmasi. Padahal layar Sales sudah berpindah
     * ke Pesanan Saya sebelum jawaban ini sampai, jadi tidak ada yang
     * memakainya.
     *
     * Yang dikirim balik cukup nomor dan tahapnya, untuk pemberitahuan
     * "sudah diteruskan ke Gudang".
     */
    /*
     * Angkanya diambil dari hasil perhitungan barusan, bukan dibaca
     * ulang dari sheet. Perhitungan itu sudah menghasilkan jumlah
     * barang dan totalnya — membacanya lagi cuma menambah satu
     * perjalanan untuk angka yang sudah ada di tangan.
     */
    var state = {
      ringkas: true,
      header: {
        trx_id: String(trx.trx_id), trx_no: trxNo,
        cust_name: String(trx.cust_name_snap),
        stage_status: tahapBaru, stage_label: stageLabelCh_(tahapBaru, saluran),
        item_count: (hitung && hitung.item_count) || Number(trx.item_count) || 0,
        grand_total: (hitung && hitung.grand_total) || Number(trx.grand_total) || 0
      }
    };

    /*
     * Layar Admin ikut diberi tahu ada perubahan.
     *
     * Pemberitahuannya sendiri hanya untuk Gudang — Admin belum punya
     * pekerjaan di sini. Tapi daftar Cetak Resep miliknya sudah
     * menampilkan pesanan sejak dikonfirmasi, dan tanpa penanda ini
     * layarnya tidak tahu harus menyegar. Akibatnya Admin menekan
     * muat ulang berkali-kali menunggu sesuatu yang sebenarnya sudah
     * ada.
     *
     * Sales juga, karena layar Cetak Resep miliknya menampilkan
     * pesanan yang baru saja dia konfirmasi. Begitu ditekan
     * konfirmasi, resepnya harus sudah bisa dicetak — bukan setelah
     * menekan muat ulang beberapa kali.
     *
     * Ini hanya menaikkan penanda, bukan mengirim pemberitahuan —
     * jadi tidak ada lonceng berbunyi untuk pekerjaan yang bukan
     * miliknya.
     */
    try {
      bumpPulse_('ADMIN');
      bumpPulse_('SALES');
      bumpPulse_('SUPERADMIN');
    } catch (eP) {}

    logAudit_(session, {
      entity: 'TRX', entity_id: trx.trx_id, trx_no: trxNo,
      action: 'STAGE_CHANGE', field: 'stage_status',
      old_value: 'DRAFT', new_value: tahapBaru,
      reason: indent ? String(payload.indent_note || 'Barang indent') : ''
    });
    logTimeline_(session, {
      trx_id: trx.trx_id, trx_no: trxNo,
      event_code: indent ? 'SALES_CONFIRM_INDENT' : 'SALES_CONFIRM',
      stage_after: tahapBaru,
      event_label: (indent ? 'Pesanan indent dikonfirmasi' : 'Pesanan dikonfirmasi') +
        (trx.sales_name ? ' · sales ' + trx.sales_name : '') +
        ' · diinput oleh ' + session.full_name,
      detail: items.length + ' item · ' + formatRp_(state.header.grand_total) +
        (indent && payload.indent_note ? ' · ' + payload.indent_note : '')
    });

    var ringkasPesanan = trxNo + ' · ' + trx.cust_name_snap +
          (trx.sales_name ? ' · Sales ' + trx.sales_name : '') +
          ' · ' + items.length + ' item';

    /*
     * Divisi penyiap diberi tahu juga untuk pesanan indent.
     *
     * Barangnya belum datang, jadi belum ada yang bisa dikerjakan —
     * tapi kalau sama sekali tidak dikabari, pesanan itu baru
     * diingat saat ada yang bertanya berhari-hari kemudian.
     *
     * Tingkatnya lebih rendah supaya tidak membunyikan alarm:
     * ini pemberitahuan, bukan panggilan kerja.
     */
    pushNotif_({
      target_role: (saluran === 'ONLINE' ? 'EKSEKUSI' : 'GUDANG'),
      target_branch: trx.branch,
      trx_id: trx.trx_id, trx_no: trxNo,
      type: 'NEW_ORDER', priority: 'HIGH',
      title: indent ? 'Pesanan indent — resep perlu dicetak' : 'Pesanan baru',
      body: ringkasPesanan +
        (indent ? ' · barangnya belum datang, cetak resepnya dulu' : '')
    });

    // Admin ikut diberi tahu sejak pesanan masuk, bukan menunggu Gudang
    // selesai. Dengan begitu Admin bisa melihat sendiri kalau ada yang
    // menumpuk, tanpa perlu ada yang melapor.
    pushNotif_({
      target_role: 'ADMIN', target_branch: trx.branch,
      trx_id: trx.trx_id, trx_no: trxNo,
      type: 'NEW_ORDER', priority: 'NORMAL',
      title: indent ? 'Pesanan indent dibuat' : 'Pesanan baru masuk Gudang',
      body: ringkasPesanan + ' · ' + formatRp_(state.header.grand_total) +
        (indent ? ' · menunggu barang datang' : '')
    });

    jam.selesai();
    return state;
  });
}

function formatRp_(n) {
  return 'Rp' + (Number(n) || 0).toLocaleString('id-ID');
}

// ============================================================
// BARANG INDENT SUDAH DATANG
// ============================================================

function apiBarangDatang(payload) {
  /*
   * Yang menandai barang datang bisa Sales atau divisi penyiap.
   *
   * Siapa pun yang pertama tahu barangnya sampai — kadang Sales yang
   * dikabari supplier, kadang Gudang yang menerima kirimannya.
   * Menahannya pada satu divisi berarti pesanan menunggu orang yang
   * kebetulan tidak ada di tempat.
   */
  return withGuard_(payload, { lock: true }, function (session) {
    if (!hasPerm_(session, 'TRX_CONFIRM_SALES') &&
        !hasPerm_(session, 'TRX_CONFIRM_GUDANG')) {
      throw appErr_('FORBIDDEN', 'Anda tidak punya akses untuk menandai barang datang.');
    }
    var trx = Repo.findOne(DB.SHEET.TRX, 'trx_id', payload.trx_id);
    if (!trx) throw appErr_('NOT_FOUND', 'Transaksi tidak ditemukan.');
    if (Util.isTrue(trx.is_void)) throw appErr_('VOIDED', 'Pesanan ini sudah dibatalkan.');

    if (String(trx.stage_status) !== 'MENUNGGU_BARANG') {
      throw appErr_('STAGE_LOCKED',
        'Pesanan ini tidak sedang menunggu barang. Status sekarang: ' +
        stageLabel_(trx.stage_status) + '.');
    }

    var now = nowIso_();
    bumpRevision_(session, trx, {
      stage_status: 'MENUNGGU_GUDANG',
      sales_confirm_at: now          // waktu tunggu Gudang dihitung dari sini
    });

    logAudit_(session, {
      entity: 'TRX', entity_id: trx.trx_id, trx_no: trx.trx_no,
      action: 'STAGE_CHANGE', field: 'stage_status',
      old_value: 'MENUNGGU_BARANG', new_value: 'MENUNGGU_GUDANG',
      reason: payload.catatan || 'Barang indent sudah datang'
    });
    logTimeline_(session, {
      trx_id: trx.trx_id, trx_no: trx.trx_no,
      event_code: 'BARANG_DATANG', stage_after: 'MENUNGGU_GUDANG',
      event_label: session.full_name + ' menandai barang indent sudah datang',
      detail: String(payload.catatan || '')
    });

    pushNotif_({
      target_role: peranPenyiap_(trx), target_branch: trx.branch,
      trx_id: trx.trx_id, trx_no: trx.trx_no,
      type: 'NEW_ORDER', priority: 'HIGH',
      title: 'Pesanan indent siap disiapkan',
      body: trx.trx_no + ' · ' + trx.cust_name_snap + ' · barangnya sudah datang'
    });

    return { trx_no: String(trx.trx_no), stage: 'MENUNGGU_GUDANG' };
  });
}

/** Daftar pesanan yang menunggu barang datang */
function apiIndentList(payload) {
  // Dibaca dari sumbernya — nama yang baru dipilih harus langsung
  // terlihat, bukan beberapa menit kemudian
  try { Repo.bustSheet(DB.SHEET.TRX); } catch (eB) {}

  /*
   * Dibuka dua jenis divisi.
   *
   * Sales melihat pesanan indent yang dia buat; Gudang dan Eksekusi
   * melihat yang akan mereka siapkan begitu barangnya datang. Dua
   * izin yang berbeda, satu daftar yang sama — jadi pemeriksaannya
   * di dalam, bukan satu izin tunggal di pintu masuk.
   */
  return withGuard_(payload, {}, function (session) {
    if (!hasPerm_(session, 'TRX_VIEW_OWN') && !hasPerm_(session, 'TRX_VIEW_STAGE')) {
      throw appErr_('FORBIDDEN', 'Anda tidak punya akses ke daftar ini.');
    }
    var semua = hasPerm_(session, 'TRX_VIEW_ALL');
    var sekarang = new Date().getTime();

    var rows = Repo.columns(DB.SHEET.TRX, [
      'trx_id', 'trx_no', 'branch', 'trx_date', 'cust_name_snap', 'cust_phone_snap',
      'sales_name', 'sales_user_id', 'stage_status', 'item_count', 'grand_total',
      'indent_note', 'sales_confirm_at', 'nota_indent', 'payment_status',
      'channel', 'sumber', 'metode_serah',
      'gudang_petugas_nama', 'eksekusi_pic_nama', 'resep_print_count',
      'paid_total', 'outstanding', 'is_void'
    ]);

    /*
     * Disaring per divisi, sama seperti antrian penyiapan.
     *
     * Barang indent yang datang nanti disiapkan oleh divisi yang sama
     * dengan yang menangani pesanannya — Gudang untuk ritel, Eksekusi
     * untuk online. Jadi daftar tunggunya juga dipisah, supaya
     * masing-masing tidak perlu memilah milik divisi sebelah.
     */
    var peranI = String(session.role);
    var hanyaI = '';
    if (peranI === 'GUDANG' || peranI === 'SALES') hanyaI = 'RITEL';
    else if (peranI === 'EKSEKUSI' || peranI === 'SALES_ONLINE') hanyaI = 'ONLINE';

    var out = [];
    rows.forEach(function (t) {
      if (Util.isTrue(t.is_void)) return;
      if (String(t.stage_status) !== 'MENUNGGU_BARANG') return;
      if (!semua && String(t.branch) !== String(session.branch)) return;

      var chI = String(t.channel || 'RITEL').toUpperCase();
      if (hanyaI === 'RITEL' && chI === 'ONLINE') return;
      if (hanyaI === 'ONLINE' && chI !== 'ONLINE') return;

      var mulai = t.sales_confirm_at
        ? new Date(Util.isoStr(t.sales_confirm_at)).getTime() : sekarang;

      out.push({
        trx_id: String(t.trx_id), trx_no: String(t.trx_no),
        trx_date: Util.dateStr(t.trx_date),
        cust_name: String(t.cust_name_snap), cust_phone: Util.hp(t.cust_phone_snap),
        sales_name: String(t.sales_name || ''),
        item_count: Number(t.item_count) || 0,
        grand_total: Number(t.grand_total) || 0,
        catatan: String(t.indent_note || ''),
        nota_indent: String(t.nota_indent || ''),
        channel: String(t.channel || 'RITEL'),
        sumber: String(t.sumber || ''),
        metode_serah: String(t.metode_serah || ''),
        payment_status: String(t.payment_status || 'BELUM_BAYAR'),
        paid_total: Number(t.paid_total) || 0,
        outstanding: Number(t.outstanding) || 0,
        hari: Math.max(Math.floor((sekarang - mulai) / 86400000), 0)
      });
    });

    // Yang belum bernota pesanan didahulukan — itu yang menahan
    // customer dari membayar
    out.sort(function (a, b) {
      var na = a.nota_indent ? 1 : 0, nb = b.nota_indent ? 1 : 0;
      if (na !== nb) return na - nb;
      return b.hari - a.hari;
    });

    return {
      list: out, total: out.length,
      belumNota: out.filter(function (x) { return !x.nota_indent; }).length,
      bisaNota: hasPerm_(session, 'NOTA_INPUT')
    };
  });
}

/** Menyiapkan tahap dan kolom untuk pesanan indent — jalankan sekali */
function siapkanIndent() {
  var pesan = [];

  // Kolom catatan indent
  var sh = Repo.sheet(DB.SHEET.TRX);
  var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0]
               .map(function (v) { return String(v).trim(); });

  if (head.indexOf('indent_note') < 0) {
    var k = sh.getLastColumn() + 1;
    if (sh.getMaxColumns() < k) sh.insertColumnsAfter(sh.getMaxColumns(), 1);
    sh.getRange(1, k).setValue('indent_note').setFontWeight('bold').setBackground('#f1f3f4');
    sh.setColumnWidth(k, 220);
    pesan.push('Kolom indent_note ditambahkan di TRANSACTIONS.');
  } else {
    pesan.push('Kolom indent_note sudah ada.');
  }

  // Tahap dan labelnya di STATUS_MASTER
  pesan.push(isiStatusMaster_());

  Repo.clearHeaderCache();
  bersihkanCache();

  return kabar_(pesan.join('\n') + '\n\n' +
    'Di layar Sales sekarang ada tombol kedua di samping Konfirmasi pesanan: ' +
    '"Pesanan indent". Pesanan indent tidak masuk antrian Gudang dan tidak ' +
    'membunyikan alarm, sampai ada yang menekan "Barang sudah datang".');
}

// ============================================================
// MEMBATALKAN DRAFT YANG TIDAK JADI DIPAKAI
//
// Sales sering membuat pesanan lalu salah, atau customernya berubah
// pikiran sebelum apa pun dikonfirmasi. Draft yang menumpuk membuat
// daftar pesanan sulit dibaca — dan yang sulit dibaca akan diabaikan.
//
// Draft yang sudah ada barangnya DIBATALKAN, bukan dihapus: catatan
// "pesanan dibuat" sudah terlanjur ada di audit log, dan jejak yang
// menunjuk ke transaksi yang hilang lebih buruk daripada baris batal
// yang jelas alasannya.
//
// Draft yang nol item dihapus betulan. Tidak ada isinya, tidak ada
// yang bisa hilang.
// ============================================================

function apiBatalkanDraft(payload) {
  return withGuard_(payload, { permission: 'TRX_EDIT_OWN', lock: true }, function (session) {
    var trx = Repo.findOne(DB.SHEET.TRX, 'trx_id', payload.trx_id);
    if (!trx) throw appErr_('NOT_FOUND', 'Pesanan tidak ditemukan.');
    if (Util.isTrue(trx.is_void)) throw appErr_('ALREADY', 'Pesanan ini sudah dibatalkan.');

    if (String(trx.stage_status) !== 'DRAFT') {
      throw appErr_('STAGE_LOCKED',
        'Hanya draft yang bisa dibatalkan sendiri. Pesanan ini sudah pada tahap "' +
        stageLabel_(trx.stage_status) + '" — minta Admin untuk membatalkannya.');
    }

    // Sales hanya boleh membatalkan pesanannya sendiri
    if (!hasPerm_(session, 'TRX_EDIT_ALL') &&
        String(trx.sales_user_id) !== String(session.user_id)) {
      throw appErr_('FORBIDDEN', 'Pesanan ini dibuat dari akun lain.');
    }

    var jumlahItem = Repo.findManyFast(DB.SHEET.ITEMS, 'trx_id', trx.trx_id)
      .filter(function (i) { return Util.isTrue(i.is_active); }).length;

    var alasan = String(payload.reason || '').trim();

    // Yang sudah ada barangnya perlu alasan
    if (jumlahItem > 0 && alasan.length < 3) {
      throw appErr_('NO_REASON',
        'Pesanan ini sudah berisi ' + jumlahItem + ' barang. Isi alasannya dulu.');
    }

    if (jumlahItem === 0) {
      Repo.deleteRow(DB.SHEET.TRX, trx._row);
      logAudit_(session, {
        entity: 'TRX', entity_id: trx.trx_id, trx_no: trx.trx_no,
        action: 'DELETE', old_value: 'draft kosong', new_value: '(dihapus)',
        reason: alasan || 'Draft kosong, tidak jadi dipakai'
      });
      return { mode: 'HAPUS', pesan: 'Draft kosong dihapus.' };
    }

    bumpRevision_(session, trx, {
      stage_status: 'DIBATALKAN', is_void: true,
      void_reason: alasan, void_by: session.user_id, void_at: nowIso_()
    });

    logAudit_(session, {
      entity: 'TRX', entity_id: trx.trx_id, trx_no: trx.trx_no,
      action: 'VOID', old_value: 'DRAFT · ' + jumlahItem + ' item',
      new_value: '(dibatalkan)', reason: alasan
    });
    logTimeline_(session, {
      trx_id: trx.trx_id, trx_no: trx.trx_no,
      event_code: 'TRX_VOID', stage_after: 'DIBATALKAN',
      event_label: session.full_name + ' membatalkan draft pesanan',
      detail: jumlahItem + ' item · ' + alasan
    });

    return {
      mode: 'BATAL',
      pesan: 'Draft dibatalkan. Barisnya tetap ada di database beserta alasannya.'
    };
  });
}

// ============================================================
// MEMINDAHKAN PESANAN YANG SUDAH DI GUDANG MENJADI INDENT
//
// Kejadian nyata: barangnya ada, tapi tinggal unit display dan
// customer tidak berkenan. Akhirnya dipesan dari cabang lain.
//
// Tanpa jalan resmi, yang terjadi biasanya pesanan dibatalkan lalu
// dibuat ulang — nomornya berubah, riwayatnya terputus, dan Gudang
// tidak pernah tahu kenapa pesanan yang sedang disiapkannya hilang.
//
// Dengan ini nomor dan riwayatnya tetap, Gudang diberi tahu supaya
// berhenti mencari, dan alasannya tercatat.
// ============================================================

function apiJadikanIndent(payload) {
  return withGuard_(payload, { permission: 'TRX_EDIT_OWN', lock: true }, function (session) {
    var trx = Repo.findOne(DB.SHEET.TRX, 'trx_id', payload.trx_id);
    if (!trx) throw appErr_('NOT_FOUND', 'Pesanan tidak ditemukan.');
    if (Util.isTrue(trx.is_void)) throw appErr_('VOIDED', 'Pesanan ini sudah dibatalkan.');

    var stage = String(trx.stage_status);

    if (stage === 'MENUNGGU_BARANG') {
      throw appErr_('ALREADY', 'Pesanan ini memang sudah menunggu barang datang.');
    }

    /*
     * Termasuk dari tahap Siap Nota.
     *
     * Kejadiannya: Sales mengonfirmasi sebagai pesanan biasa, Gudang
     * sudah memprosesnya, baru ketahuan barangnya harus dipesan dari
     * cabang lain. Kalau dari titik itu tidak bisa dipindah, Admin
     * terpaksa membatalkan dan membuat ulang — nomornya berubah dan
     * riwayatnya terputus.
     */
    if (['MENUNGGU_GUDANG', 'PROSES_GUDANG', 'SIAP_NOTA'].indexOf(stage) < 0) {
      throw appErr_('STAGE_LOCKED',
        'Pesanan yang sudah bernomor nota atau sudah dibayar tidak bisa dipindah ke indent. ' +
        'Status sekarang: ' + stageLabel_(stage) + '.');
    }
    if (String(trx.nota_no || '').trim()) {
      throw appErr_('STAGE_LOCKED',
        'Nota penjualan ' + trx.nota_no + ' sudah terbit. Batalkan notanya dulu ' +
        'di sistem kantor kalau memang harus jadi pesanan indent.');
    }

    if (!hasPerm_(session, 'TRX_EDIT_ALL') &&
        String(trx.sales_user_id) !== String(session.user_id)) {
      throw appErr_('FORBIDDEN', 'Pesanan ini dibuat dari akun lain.');
    }

    // Keterangan tidak wajib. Sebagian besar kasusnya sudah jelas dari
    // konteksnya, dan memaksa mengisi hanya membuat orang mengetik
    // sembarang kata supaya tombolnya bisa ditekan.
    var alasan = String(payload.reason || '').trim();

    bumpRevision_(session, trx, {
      stage_status: 'MENUNGGU_BARANG',
      indent_note: alasan.substring(0, 250),
      gudang_confirm_at: ''
    });

    logAudit_(session, {
      entity: 'TRX', entity_id: trx.trx_id, trx_no: trx.trx_no,
      action: 'STAGE_CHANGE', field: 'stage_status',
      old_value: stage, new_value: 'MENUNGGU_BARANG',
      reason: alasan || 'Dipindah ke pesanan indent'
    });
    logTimeline_(session, {
      trx_id: trx.trx_id, trx_no: trx.trx_no,
      event_code: 'JADI_INDENT', stage_after: 'MENUNGGU_BARANG',
      event_label: session.full_name + ' memindahkan pesanan ini ke indent',
      detail: alasan || 'tanpa keterangan'
    });

    // Gudang perlu tahu supaya berhenti menyiapkan
    pushNotif_({
      target_role: peranPenyiap_(trx), target_branch: trx.branch,
      trx_id: trx.trx_id, trx_no: trx.trx_no,
      type: 'ORDER_REVISED', priority: 'HIGH',
      title: 'Pesanan ditarik dari antrian',
      body: trx.trx_no + ' · ' + trx.cust_name_snap + ' · jadi indent' +
            (alasan ? ': ' + alasan : '')
    });
    pushNotif_({
      target_role: 'ADMIN', target_branch: trx.branch,
      trx_id: trx.trx_id, trx_no: trx.trx_no,
      type: 'ORDER_REVISED', priority: 'NORMAL',
      title: 'Pesanan jadi indent',
      body: trx.trx_no + ' · ' + trx.cust_name_snap + (alasan ? ' · ' + alasan : '')
    });

    return { trx_no: String(trx.trx_no), stage: 'MENUNGGU_BARANG' };
  });
}

// ============================================================
// KOLOM HARGA JUAL DASAR — jalankan sekali dari editor
// ============================================================

/**
 * Menambahkan kolom base_price di TRANSACTION_ITEMS.
 *
 * Harga master adalah acuan katalog dan tidak pernah berubah.
 * Harga jual dasar adalah harga sebelum diskon yang boleh disesuaikan
 * Sales — misalnya dinaikkan karena ada tambahan Office.
 *
 * Diskon memotong dari harga jual dasar, bukan dari harga master.
 * Sebelum ini, menaikkan harga lalu memberi diskon menghasilkan angka
 * yang salah: potongannya diambil dari harga katalog yang lebih rendah.
 */
function siapkanHargaDasar() {
  var sh = Repo.sheet(DB.SHEET.ITEMS);
  var head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0]
               .map(function (v) { return String(v).trim(); });

  if (head.indexOf('base_price') >= 0) {
    return kabar_('Kolom base_price sudah ada. Tidak ada yang perlu diubah.');
  }

  var k = sh.getLastColumn() + 1;
  if (sh.getMaxColumns() < k) sh.insertColumnsAfter(sh.getMaxColumns(), 1);
  sh.getRange(1, k).setValue('base_price').setFontWeight('bold').setBackground('#f1f3f4');
  sh.setColumnWidth(k, 120);

  // Baris lama: harga jual dasarnya sama dengan harga master, karena
  // dulu diskon memang dihitung dari situ
  var lr = sh.getLastRow();
  if (lr > 1) {
    var iMaster = head.indexOf('master_price');
    if (iMaster >= 0) {
      var master = sh.getRange(2, iMaster + 1, lr - 1, 1).getValues();
      sh.getRange(2, k, lr - 1, 1).setValues(master);
    }
  }

  Repo.clearHeaderCache();
  bersihkanCache();

  return kabar_('Kolom base_price ditambahkan di TRANSACTION_ITEMS, dan baris lama ' +
    'diisi dengan harga masternya.\n\n' +
    'Sekarang kolom Harga di layar Sales adalah harga jual sebelum diskon. ' +
    'Diskon memotong dari angka itu, bukan dari harga katalog.');
}

// ============================================================
// MEMBATALKAN PESANAN YANG SUDAH DIKONFIRMASI
//
// Customer berubah pikiran setelah pesanan masuk ke Gudang, atau
// bahkan setelah barangnya disiapkan. Tanpa jalan resmi, pesanan itu
// menggantung selamanya di antrian Resep & Nota — dan lama-lama
// antriannya penuh hal yang tidak perlu dikerjakan siapa pun.
//
// Yang dijaga: pesanan yang sudah ada uangnya tidak bisa dibatalkan
// begitu saja. Pembayarannya harus dibatalkan lebih dulu oleh Super
// Admin, supaya tidak ada uang yang tercatat masuk untuk transaksi
// yang dianggap tidak pernah ada.
// ============================================================

function apiBatalkanTransaksi(payload) {
  return withGuard_(payload, { permission: 'TRX_EDIT_OWN', lock: true }, function (session) {
    var trx = Repo.findOne(DB.SHEET.TRX, 'trx_id', payload.trx_id);
    if (!trx) throw appErr_('NOT_FOUND', 'Pesanan tidak ditemukan.');
    if (Util.isTrue(trx.is_void)) throw appErr_('ALREADY', 'Pesanan ini sudah dibatalkan.');

    var stage = String(trx.stage_status);

    if (stage === 'DRAFT') {
      throw appErr_('IS_DRAFT', 'Pesanan ini masih draft. Pakai tombol Batalkan di Pesanan Saya.');
    }
    if (stage === 'SELESAI') {
      throw appErr_('STAGE_LOCKED',
        'Transaksi ini sudah selesai dan barangnya sudah diserahkan. ' +
        'Yang berlaku sekarang retur, bukan pembatalan.');
    }

    // Uang yang sudah masuk harus diurus dulu
    var terbayar = Number(trx.paid_total) || 0;
    if (terbayar > 0) {
      throw appErr_('ADA_PEMBAYARAN',
        'Transaksi ini sudah menerima pembayaran ' + formatRp_(terbayar) + '. ' +
        'Minta Super Admin membatalkan pembayarannya dulu lewat Riwayat Bayar, ' +
        'baru pesanan ini bisa dibatalkan.');
    }

    // Sales hanya boleh membatalkan pesanannya sendiri, dan hanya
    // selama belum masuk tahap Admin
    if (!hasPerm_(session, 'TRX_EDIT_ALL')) {
      if (String(trx.sales_user_id) !== String(session.user_id)) {
        throw appErr_('FORBIDDEN', 'Pesanan ini dibuat dari akun lain.');
      }
      if (['MENUNGGU_GUDANG', 'PROSES_GUDANG', 'MENUNGGU_BARANG'].indexOf(stage) < 0) {
        throw appErr_('STAGE_LOCKED',
          'Pesanan sudah pada tahap "' + stageLabel_(stage) + '". Minta Admin membatalkannya.');
      }
    }

    var alasan = String(payload.reason || '').trim();
    if (alasan.length < 4) {
      throw appErr_('NO_REASON',
        'Isi alasannya dulu. Ini yang dibaca divisi lain saat pesanannya hilang dari antrian.');
    }

    var now = nowIso_();

    /*
     * Serial number ikut dinonaktifkan.
     *
     * Kalau tidak, barang yang sebenarnya kembali ke rak tetap tercatat
     * sebagai sudah keluar gudang — dan SN-nya akan ditolak saat dipakai
     * untuk transaksi berikutnya, karena dianggap sudah terpakai.
     */
    var jumlahSn = 0;
    try {
      Repo.findManyFast(DB.SHEET.SN, 'trx_id', trx.trx_id).forEach(function (x) {
        if (!Util.isTrue(x.is_active)) return;
        Repo.update(DB.SHEET.SN, x._row, {
          is_active: false,
          void_reason: 'Transaksi dibatalkan: ' + alasan
        });
        jumlahSn++;
      });
    } catch (e) {}

    bumpRevision_(session, trx, {
      stage_status: 'DIBATALKAN', is_void: true,
      void_reason: alasan, void_by: session.user_id, void_at: now
    });

    logAudit_(session, {
      entity: 'TRX', entity_id: trx.trx_id, trx_no: trx.trx_no,
      action: 'VOID', field: 'stage_status',
      old_value: stage, new_value: 'DIBATALKAN', reason: alasan
    });
    logTimeline_(session, {
      trx_id: trx.trx_id, trx_no: trx.trx_no,
      event_code: 'TRX_VOID', stage_after: 'DIBATALKAN',
      event_label: session.full_name + ' membatalkan pesanan',
      detail: alasan + (jumlahSn ? ' · ' + jumlahSn + ' SN dikembalikan' : '')
    });

    // Divisi yang sedang menunggu pesanan ini perlu tahu, supaya berhenti
    var isi = trx.trx_no + ' · ' + trx.cust_name_snap + ' · ' + alasan;

    if (['MENUNGGU_GUDANG', 'PROSES_GUDANG'].indexOf(stage) >= 0) {
      pushNotif_({
        target_role: peranPenyiap_(trx), target_branch: trx.branch,
        trx_id: trx.trx_id, trx_no: trx.trx_no,
        type: 'ORDER_REVISED', priority: 'HIGH',
        title: 'Pesanan dibatalkan', body: isi
      });
    }
    if (stage === 'SIAP_NOTA' || String(trx.nota_no || '').trim()) {
      pushNotif_({
        target_role: 'ADMIN', target_branch: trx.branch,
        trx_id: trx.trx_id, trx_no: trx.trx_no,
        type: 'ORDER_REVISED', priority: 'HIGH',
        title: 'Pesanan dibatalkan', body: isi
      });
    }
    if (stage === 'MENUNGGU_PEMBAYARAN') {
      pushNotif_({
        target_role: 'KASIR', target_branch: trx.branch,
        trx_id: trx.trx_id, trx_no: trx.trx_no,
        type: 'ORDER_REVISED', priority: 'HIGH',
        title: 'Pesanan dibatalkan', body: isi
      });
    }

    return {
      trx_no: String(trx.trx_no), sn_dikembalikan: jumlahSn,
      pesan: 'Pesanan dibatalkan.' +
        (jumlahSn ? ' ' + jumlahSn + ' serial number dikembalikan dan bisa dipakai lagi.' : '') +
        (String(trx.nota_no || '').trim()
          ? ' Nota ' + trx.nota_no + ' sudah terbit di sistem kantor — batalkan juga di sana.'
          : '')
    };
  });
}

// ============================================================
// LABEL TAHAP TRANSAKSI
// ============================================================

/**
 * Mengisi sheet STATUS_MASTER dengan seluruh tahap beserta labelnya.
 *
 * Sheet ini yang mengubah kode seperti MENUNGGU_GUDANG menjadi tulisan
 * "Menunggu Gudang" di layar. Selama kosong, yang terbaca staf adalah
 * kode mentahnya.
 *
 * Aman dijalankan berulang — yang sudah ada tidak ditulis dua kali.
 */
function isiStatusMaster_() {
  var sh = Repo.sheet(DB.SHEET.STATUS);
  var judul = DB.HEADERS[DB.SHEET.STATUS];

  // Baris judul dulu kalau sheetnya masih kosong
  if (sh.getLastRow() < 1 || sh.getLastColumn() < 1) {
    sh.getRange(1, 1, 1, judul.length).setValues([judul])
      .setFontWeight('bold').setBackground('#f1f3f4');
    sh.setFrozenRows(1);
    Repo.clearHeaderCache();
  }

  var tahap = [
    ['DRAFT',               'Draft Pesanan',        10, '#6A7482', 'SALES',   false],
    ['MENUNGGU_BARANG',     'Menunggu Barang Datang', 15, '#7C3AED', 'SALES',  false],
    ['MENUNGGU_GUDANG',     'Menunggu Gudang',      20, '#0B5FFF', 'GUDANG',  false],
    ['PROSES_GUDANG',       'Proses Gudang',        30, '#E0A030', 'GUDANG',  false],
    ['SIAP_NOTA',           'Siap Dibuat Nota',     40, '#E0A030', 'ADMIN',   false],
    ['MENUNGGU_PEMBAYARAN', 'Menunggu Pembayaran',  50, '#E0A030', 'KASIR',   false],
    ['MENUNGGU_AKTIVASI',   'Menunggu Teknisi',     60, '#0B5FFF', 'TEKNISI', false],
    ['SIAP_SERAH',          'Siap Diserahkan',      65, '#1A9E5C', 'EKSEKUSI', false],
    ['PROSES_AKTIVASI',     'Dikerjakan Teknisi',   70, '#0B5FFF', 'TEKNISI', false],
    ['AKTIVASI_SELESAI',    'Selesai di Teknisi',   80, '#1A9E5C', 'TEKNISI', false],
    ['SELESAI',             'Transaksi Selesai',    90, '#1A9E5C', '',        true],
    ['DIBATALKAN',          'Dibatalkan',           99, '#D04545', '',        true]
  ];

  var sudahAda = {};
  try {
    Repo.columns(DB.SHEET.STATUS, ['status_code']).forEach(function (r) {
      var k = String(r.status_code || '').trim();
      if (k) sudahAda[k] = true;
    });
  } catch (e) {}

  var head = Repo.headers(DB.SHEET.STATUS);
  var barisBaru = [];

  tahap.forEach(function (t) {
    if (sudahAda[t[0]]) return;
    var o = {
      status_code: t[0], label: t[1], type: 'STAGE', order: t[2],
      color_hex: t[3], icon: '', owner_role: t[4],
      next_allowed: '', is_terminal: t[5]
    };
    barisBaru.push(head.map(function (k) { return o[k] === undefined ? '' : o[k]; }));
  });

  if (!barisBaru.length) {
    return 'STATUS_MASTER sudah lengkap, ' + Object.keys(sudahAda).length + ' tahap terdaftar.';
  }

  sh.getRange(sh.getLastRow() + 1, 1, barisBaru.length, head.length).setValues(barisBaru);
  Repo.bustSheet(DB.SHEET.STATUS);

  return barisBaru.length + ' tahap ditambahkan ke STATUS_MASTER. ' +
    'Sekarang layar menampilkan nama tahap, bukan kode mentahnya.';
}

/** Dijalankan sendiri dari editor kalau label tahap perlu dilengkapi */
function siapkanStatusMaster() {
  var hasil = isiStatusMaster_();
  Repo.clearHeaderCache();
  bersihkanCache();
  return kabar_(hasil);
}

/**
 * Menutup pesanan indent yang barangnya sudah diambil di luar sistem.
 *
 * Kejadian nyata: barangnya datang, customer kebetulan sedang di toko,
 * dan langsung dibawa tanpa ada yang mencatatnya di aplikasi. Di sistem
 * pesanannya tetap berdiri di Menunggu Barang — kadang berbulan-bulan,
 * ikut terhitung sebagai pekerjaan, dan menghalangi pengarsipan.
 *
 * Membatalkannya salah: uangnya sudah diterima dan barangnya memang
 * keluar. Yang benar adalah mencatat apa yang sebenarnya terjadi —
 * selesai, diserahkan, dengan keterangan bahwa penyerahannya tidak
 * lewat sistem dan siapa yang menutup.
 */
function apiTutupIndentManual(payload) {
  return withGuard_(payload, { permission: 'NOTA_INPUT', lock: 'ringan' }, function (session) {
    var trx = Repo.findOne(DB.SHEET.TRX, 'trx_id', payload.trx_id);
    if (!trx) throw appErr_('NOT_FOUND', 'Transaksi tidak ditemukan.');
    if (Util.isTrue(trx.is_void)) throw appErr_('VOIDED', 'Transaksi ini sudah dibatalkan.');

    if (String(trx.stage_status) !== 'MENUNGGU_BARANG') {
      throw appErr_('STAGE_LOCKED',
        'Ini hanya untuk pesanan yang masih menunggu barang. Status sekarang: ' +
        stageLabel_(trx.stage_status) + '.');
    }

    var alasan = String(payload.alasan || '').trim();
    if (alasan.length < 5) {
      throw appErr_('NO_REASON',
        'Tulis dulu apa yang terjadi. Keterangan ini satu-satunya penjelasan ' +
        'kenapa pesanan ini selesai tanpa melewati Gudang dan Teknisi.');
    }

    var now = nowIso_();
    var flags = {};
    try { flags = JSON.parse(String(trx.override_flags || '') || '{}'); } catch (e) {}

    flags.diserahkan = {
      at: now, by: session.full_name, user_id: session.user_id,
      note: 'Diambil di luar sistem — ' + alasan
    };
    flags.tutup_manual = { at: now, by: session.full_name, alasan: alasan };

    bumpRevision_(session, trx, {
      stage_status: 'SELESAI',
      completed_at: now,
      override_flags: JSON.stringify(flags)
    });

    logAudit_(session, {
      entity: 'TRX', entity_id: trx.trx_id, trx_no: trx.trx_no,
      action: 'STAGE_CHANGE', field: 'stage_status',
      old_value: 'MENUNGGU_BARANG', new_value: 'SELESAI',
      reason: 'Ditutup manual — ' + alasan
    });

    logTimeline_(session, {
      trx_id: trx.trx_id, trx_no: trx.trx_no,
      event_code: 'TUTUP_MANUAL', stage_after: 'SELESAI',
      event_label: session.full_name + ' menutup pesanan tanpa lewat sistem',
      detail: alasan
    });

    flushLog_();

    return { ok: true, trx_no: String(trx.trx_no) };
  });
}

/** Pilihan khusus pesanan online untuk layar Sales */
function apiPilihanOnline(payload) {
  return withGuard_(payload, {}, function () {
    Settings.bust();

    var pecah = function (kunci) {
      return String(Settings.get(kunci, '') || '').split(',')
        .map(function (x) { return x.trim(); })
        .filter(function (x) { return x; });
    };

    var hari = pecah('TEMPO_HARI').map(function (x) { return Number(x) || 0; })
                 .filter(function (x) { return x > 0; });

    return {
      sumber: pecah('SUMBER_ONLINE'),
      gedung: pecah('GEDUNG_LIST'),
      metode: pecah('METODE_SERAH'),
      kerja: pecah('KERJA_TEKNISI'),
      bayar: pecah('CARA_BAYAR_ONLINE'),
      tempo: hari.length ? hari : [3, 7, 14, 30, 45, 60, 90]
    };
  });
}

/**
 * Omzet hari ini untuk satu kode sales.
 *
 * Dipakai akun sales perorangan: yang dihitung pesanan yang memakai
 * kode salesnya, bukan yang kebetulan dia yang mengetik. Dua hal
 * itu berbeda — sales sering saling menggantikan saat yang satu
 * sedang melayani.
 *
 * Nota yang dibatalkan tidak dihitung. Yang belum bernota ikut
 * ditampilkan terpisah, supaya terlihat mana yang sudah pasti dan
 * mana yang masih berjalan.
 */
function apiOmsetSaya(payload) {
  return withGuard_(payload, {}, function (session) {
    var kode = String(payload.sales_code || session.sales_code || '').trim().toUpperCase();
    if (!kode) return { ada: false };

    var tgl = String(payload.tanggal || Util.todayStr());
    var semuaCabang = hasPerm_(session, 'TRX_VIEW_ALL');

    var bernota = 0, nilaiNota = 0;
    var berjalan = 0, nilaiJalan = 0;
    var daftar = [];

    Repo.columns(DB.SHEET.TRX, [
      'trx_id', 'trx_no', 'branch', 'trx_date', 'cust_name_snap', 'sales_code',
      'stage_status', 'payment_status', 'grand_total', 'nota_no', 'nota_at',
      'item_count', 'created_at', 'is_void'
    ]).forEach(function (t) {
      if (Util.isTrue(t.is_void)) return;
      if (String(t.stage_status) === 'DRAFT') return;
      if (String(t.stage_status) === 'DIBATALKAN') return;
      if (String(t.sales_code).trim().toUpperCase() !== kode) return;
      if (!semuaCabang && String(t.branch) !== String(session.branch)) return;

      /*
       * Tanggalnya dari nota kalau sudah terbit, kalau belum dari
       * tanggal pesanannya. Yang dihitung sebagai omzet hari ini
       * adalah yang notanya terbit hari ini.
       */
      var tglNota = Util.dateStr(t.nota_at);
      var tglTrx = Util.dateStr(t.trx_date) || Util.dateStr(t.created_at);

      var punyaNota = !!String(t.nota_no || '').trim();
      var nilai = Number(t.grand_total) || 0;

      if (punyaNota && tglNota === tgl) {
        bernota++; nilaiNota += nilai;
      } else if (!punyaNota && tglTrx === tgl) {
        berjalan++; nilaiJalan += nilai;
      } else {
        return;
      }

      daftar.push({
        trx_id: String(t.trx_id), trx_no: String(t.trx_no),
        cust_name: String(t.cust_name_snap),
        nota_no: String(t.nota_no || ''),
        stage_label: stageLabelCh_(t.stage_status, t.channel),
        payment_status: String(t.payment_status),
        item_count: Number(t.item_count) || 0,
        grand_total: nilai,
        bernota: punyaNota
      });
    });

    daftar.sort(function (a, b) { return a.bernota === b.bernota ? 0 : (a.bernota ? -1 : 1); });

    return {
      ada: true, sales_code: kode, tanggal: tgl,
      bernota: bernota, nilai_nota: nilaiNota,
      berjalan: berjalan, nilai_jalan: nilaiJalan,
      list: daftar.slice(0, 60)
    };
  });
}
