/**
 * ELS.ID WORKFLOW SYSTEM — Phase 6
 * File : 13_CashierService.gs
 * Isi  : Pembayaran, DP, pelunasan, dan riwayatnya.
 *
 * Aturan yang dipegang file ini:
 * - Status pembayaran TIDAK PERNAH diketik. Selalu dihitung ulang dari
 *   riwayat pembayaran. Dengan begitu tidak mungkin ada transaksi
 *   bertanda LUNAS yang uangnya belum penuh.
 * - Riwayat pembayaran hanya bisa ditambah. Pembayaran yang salah
 *   dibatalkan (void) oleh Super Admin, bukan dihapus.
 * - Pembayaran hanya bisa dicatat setelah nomor nota ada.
 * - Begitu lunas, transaksi otomatis diteruskan ke Teknisi.
 */

var METODE_BAYAR = ['CASH', 'TRANSFER', 'EDC', 'QRIS', 'LEASING'];

// ============================================================
// PERHITUNGAN
// ============================================================

/**
 * Menghitung ulang kondisi pembayaran dari riwayatnya, lalu menyimpan
 * hasilnya ke transaksi. Dipanggil setiap kali pembayaran berubah,
 * dan juga saat isi pesanan berubah.
 */
/**
 * Menghitung ulang status pembayaran dari seluruh riwayatnya.
 *
 * bayarKnown: daftar pembayaran yang SUDAH ada di memori pemanggil.
 * Kalau diberikan, sheet pembayaran tidak dibaca ulang.
 *
 * Alasannya: pencatatan pembayaran baru saja menulis ke sheet itu,
 * dan penulisan membatalkan salinan — jadi pembacaan berikutnya
 * mengambil seluruh isinya dari nol. Dari pengukuran, itu memakan
 * dua detik dari tiga detik total.
 */
function hitungPembayaran_(trxId, bayarKnown, trxKnown) {
  var trx = trxKnown || Repo.findOne(DB.SHEET.TRX, 'trx_id', trxId);
  if (!trx) return null;

  var bayar = bayarKnown ||
    Repo.findManyFast(DB.SHEET.PAYMENTS, 'trx_id', trxId);
  bayar = bayar.filter(function (p) { return !Util.isTrue(p.is_void); });

  var total = Number(trx.grand_total) || 0;
  var masuk = 0, adaRefund = false, terakhir = '', kasirTerakhir = '';

  bayar.sort(function (a, b) {
    return String(a.paid_at) < String(b.paid_at) ? -1 : 1;
  }).forEach(function (p) {
    var n = Number(p.amount) || 0;
    if (String(p.type) === 'REFUND') { masuk -= n; adaRefund = true; }
    else masuk += n;
    terakhir = Util.isoStr(p.paid_at);
    kasirTerakhir = String(p.cashier_user_id || '');
  });

  var sisa = total - masuk;
  var status;

  /*
   * Nota tanpa tagihan langsung dianggap lunas.
   *
   * Nilainya nol dan memang tidak ada yang ditagih — apa pun
   * sebabnya: bonus, potongan penuh, atau unit pengganti.
   *
   * Tanpa aturan ini pesanannya tertahan di Kasir selamanya —
   * tidak ada yang bisa dibayarkan, dan tidak ada tombol yang
   * bisa ditekan. Barangnya pun tidak pernah sampai ke customer.
   */
  if (total <= 0 && masuk <= 0 && !adaRefund) status = 'LUNAS';
  else if (masuk <= 0) status = adaRefund ? 'REFUND' : 'BELUM_BAYAR';
  else if (masuk < total) status = 'DP';
  else status = 'LUNAS';

  var patch = {
    paid_total: masuk,
    outstanding: sisa,
    payment_status: status
  };
  if (status === 'LUNAS' && !trx.paid_at) patch.paid_at = terakhir || nowIso_();
  if (status !== 'LUNAS') patch.paid_at = '';
  if (kasirTerakhir) patch.cashier_user_id = kasirTerakhir;

  // Tidak menulis kalau hasilnya sama dengan yang sudah tersimpan
  var berubah = false;
  Object.keys(patch).forEach(function (k) {
    if (String(trx[k] === undefined ? '' : trx[k]) !== String(patch[k])) berubah = true;
  });

  if (berubah) Repo.tundaUpdate(DB.SHEET.TRX, trx._row, patch);

  return {
    total: total, masuk: masuk, sisa: sisa,
    status: status, statusLama: String(trx.payment_status),
    jumlahBayar: bayar.length, trx: trx
  };
}

function bacaPembayaran_(trxId) {
  return Repo.findManyFast(DB.SHEET.PAYMENTS, 'trx_id', trxId)
    .sort(function (a, b) { return Number(a.seq) - Number(b.seq); })
    .map(function (p) {
      return {
        payment_id: String(p.payment_id), seq: Number(p.seq) || 0,
        type: String(p.type), amount: Number(p.amount) || 0,
        method: String(p.method || ''), ref_no: String(p.ref_no || ''),
        paid_at: Util.isoStr(p.paid_at),
        cashier_name: String(p.cashier_name || ''),
        note: String(p.note || ''),
        is_void: Util.isTrue(p.is_void),
        void_reason: String(p.void_reason || ''),
        void_by: String(p.void_by || '')
      };
    });
}

// ============================================================
// API — ANTRIAN KASIR
// ============================================================

function apiKasirQueue(payload) {
  return withGuard_(payload, { permission: 'PAYMENT_ADD' }, function (session) {
    var scope = String(payload.scope || 'menunggu');
    var semuaCabang = hasPerm_(session, 'TRX_VIEW_ALL');
    var today = Util.todayStr();
    var sekarang = new Date().getTime();

    var rows = Repo.columns(DB.SHEET.TRX, [
      'trx_id', 'trx_no', 'branch', 'trx_date', 'cust_name_snap', 'cust_phone_snap',
      'sales_name', 'stage_status', 'payment_status', 'item_count',
      'grand_total', 'paid_total', 'outstanding', 'nota_no', 'nota_at',
      'nota_indent', 'nota_indent_at', 'updated_at', 'paid_at',
      'tempo_hari', 'tempo_jatuh', 'cara_bayar', 'is_void'
    ]);

    /*
     * Pembacaan segar hanya saat diminta.
     *
     * Membaca ulang seluruh sheet tiap kali membuat perpindahan tab
     * terasa berat — dan layar yang lambat lebih mengganggu daripada
     * data yang telat beberapa detik.
     *
     * Jadi: segar saat orangnya berpindah tab atau menekan muat
     * ulang; selebihnya memakai salinan, yang sudah dibuang sendiri
     * setiap kali ada yang menulis.
     */
    if (Util.isTrue(payload.segar)) {
      try { Repo.bustSheet(DB.SHEET.TRX); } catch (eB) {}
    }

    var out = [], rekap = { menunggu: 0, dp: 0, lunasHariIni: 0, nilaiMenunggu: 0, nilaiPiutang: 0 };

    for (var i = 0; i < rows.length; i++) {
      var t = rows[i];
      /*
       * Yang dibatalkan tidak boleh muncul sama sekali.
       *
       * Dua penyaring sekaligus — penanda batal dan tahapnya. Kalau
       * salah satunya tidak tertulis karena penyimpanan terputus di
       * tengah, yang satunya masih menahan. Transaksi batal yang
       * tetap berdiri di antrian Kasir membingungkan: terlihat ada
       * pekerjaan, padahal tidak ada yang bisa dikerjakan.
       */
      if (Util.isTrue(t.is_void)) continue;
      if (String(t.stage_status) === 'DIBATALKAN') continue;

      // Bernota penjualan atau nota pesanan indent — dua-duanya bisa dibayar
      if (!String(t.nota_no || '').trim() &&
          !String(t.nota_indent || '').trim()) continue;
      if (!semuaCabang && String(t.branch) !== String(session.branch)) continue;

      var bayarStatus = String(t.payment_status);
      var tgl = Util.dateStr(t.trx_date);
      var sisa = Number(t.outstanding) || 0;

      if (bayarStatus === 'BELUM_BAYAR') {
        rekap.menunggu++; rekap.nilaiMenunggu += Number(t.grand_total) || 0;
      } else if (bayarStatus === 'DP') {
        rekap.dp++; rekap.nilaiPiutang += sisa;
      } else if (bayarStatus === 'LUNAS' && Util.dateStr(t.paid_at) === today) {
        rekap.lunasHariIni++;
      }

      var masuk = false;
      if (scope === 'menunggu') masuk = bayarStatus === 'BELUM_BAYAR';
      else if (scope === 'dp') masuk = bayarStatus === 'DP';
      else if (scope === 'belum_lunas') masuk = bayarStatus !== 'LUNAS';
      /*
       * "Hari ini" dilihat dari tiga tanggal.
       *
       * Pesanan kemarin yang notanya terbit hari ini, atau yang
       * dibayar hari ini, tetap pekerjaan hari ini. Menilai hanya
       * dari tanggal pesanan dibuat membuat transaksi seperti itu
       * tidak pernah muncul — padahal Kasir yang mengerjakannya.
       */
      else if (scope === 'hari_ini') {
        /*
         * Nota pesanan (SO) ikut dihitung sebagai pekerjaan hari ini.
         *
         * Pesanan indent dibuat berminggu-minggu sebelumnya, lalu
         * notanya terbit saat barangnya datang. Tanggal pesanannya
         * sudah lama, dan nota penjualannya belum ada — jadi dulu
         * transaksi itu lewat dari tab Hari ini dan langsung muncul
         * di tab DP/belum lunas.
         *
         * Akibatnya Kasir tidak melihatnya di layar yang dibuka
         * pertama kali, padahal customernya sedang berdiri di depan
         * meja.
         */
        masuk = tgl === today ||
                Util.dateStr(t.nota_at) === today ||
                Util.dateStr(t.nota_indent_at) === today ||
                Util.dateStr(t.paid_at) === today;
      }
      else masuk = true;

      if (!masuk) continue;

      /*
       * Urutannya mengikuti kapan transaksi itu masuk meja Kasir.
       *
       * Sebelumnya hanya tanggal nota penjualan yang dibaca. Pesanan
       * indent belum punya nota itu — jadi waktunya dianggap "baru
       * saja", dan semua SO menempel di atas selamanya walau ada
       * transaksi yang lebih baru di bawahnya.
       *
       * Sekarang dibaca dari yang paling tepat tersedia: nota
       * penjualan, lalu nota pesanan, lalu perubahan terakhir.
       */
      /*
       * Waktu perubahan terakhir sengaja TIDAK dipakai.
       *
       * Mencatat pembayaran memperbarui waktu itu — jadi transaksi
       * yang baru saja dilunasi melompat ke paling atas, dan yang
       * belum dibayar justru tenggelam. Padahal yang belum dibayar
       * itulah pekerjaan Kasir.
       */
      var acuanWaktu = t.nota_at || t.nota_indent_at || t.trx_date;
      var acuan = acuanWaktu
        ? new Date(Util.isoStr(acuanWaktu)).getTime() : sekarang;
      if (!acuan || isNaN(acuan)) acuan = sekarang;

      var menit = Math.max(Math.round((sekarang - acuan) / 60000), 0);

      out.push({
        trx_id: String(t.trx_id), trx_no: String(t.trx_no),
        nota_no: String(t.nota_no || t.nota_indent || ''),
        nota_indent: String(t.nota_indent || ''),
        tempo_hari: Number(t.tempo_hari) || 0,
        tempo_jatuh: Util.dateStr(t.tempo_jatuh),
        cara_bayar: String(t.cara_bayar || ''),
        indent: String(t.stage_status) === 'MENUNGGU_BARANG', cust_name: String(t.cust_name_snap),
        cust_phone: Util.hp(t.cust_phone_snap), sales_name: String(t.sales_name || ''),
        stage_status: String(t.stage_status), stage_label: stageLabel_(t.stage_status),
        payment_status: bayarStatus,
        item_count: Number(t.item_count) || 0,
        grand_total: Number(t.grand_total) || 0,
        paid_total: Number(t.paid_total) || 0,
        outstanding: sisa,
        trx_date: tgl, menit: menit
      });
    }

    /*
     * Yang paling baru di atas.
     *
     * Sebelumnya diurutkan dari yang paling lama menunggu, supaya
     * tunggakan tidak terlupakan. Tapi yang dikerjakan Kasir
     * sepanjang hari adalah transaksi yang baru masuk — dan itu
     * selalu berada di dasar daftar, harus digulir tiap kali.
     *
     * Tunggakan lama tetap mudah ditemukan lewat tab "Semua belum
     * lunas" dan "Tempo berjalan", yang memang untuk itu.
     */
    /*
     * Yang belum dibayar selalu di atas, lalu yang terbaru.
     *
     * Kasir membuka layar ini untuk mencari pekerjaan, bukan untuk
     * melihat yang sudah selesai. Transaksi lunas tetap ditampilkan
     * — berguna saat ada yang menanyakan ulang — tapi tempatnya di
     * bawah.
     */
    var bobot = function (st) {
      if (st === 'BELUM_BAYAR') return 0;
      if (st === 'DP') return 1;
      return 2;
    };

    out.sort(function (a, b) {
      var ba = bobot(a.payment_status), bb = bobot(b.payment_status);
      if (ba !== bb) return ba - bb;
      return a.menit - b.menit;
    });

    return { list: out.slice(0, 150), total: out.length, rekap: rekap };
  });
}

function apiKasirGetTrx(payload) {
  return withGuard_(payload, { permission: 'PAYMENT_ADD' }, function (session) {
    return dataKasir_(session, payload.trx_id);
  });
}

function dataKasir_(session, trxId) {
  var trx = Repo.findOne(DB.SHEET.TRX, 'trx_id', trxId);
  if (!trx) throw appErr_('NOT_FOUND', 'Transaksi tidak ditemukan.');

  var items = Repo.findManyFast(DB.SHEET.ITEMS, 'trx_id', trxId)
    .filter(function (i) { return Util.isTrue(i.is_active); })
    .sort(function (a, b) { return Number(a.line_no) - Number(b.line_no); })
    .map(function (i) {
      return {
        product_code: String(i.product_code), product_name: String(i.product_name),
        qty: Number(i.qty) || 0, unit_price: Number(i.unit_price) || 0,
        line_total: (Number(i.qty) || 0) * (Number(i.unit_price) || 0),
        sn_summary: String(i.sn_summary || '')
      };
    });

  return {
    header: {
      trx_id: String(trx.trx_id), trx_no: String(trx.trx_no),
      nota_no: String(trx.nota_no || ''),
      nota_indent: String(trx.nota_indent || ''),
      cust_name: String(trx.cust_name_snap), cust_phone: Util.hp(trx.cust_phone_snap),
      sales_name: String(trx.sales_name || ''), sales_code: String(trx.sales_code || ''),
      order_note: String(trx.order_note || ''),
      stage_status: String(trx.stage_status), stage_label: stageLabel_(trx.stage_status),
      payment_status: String(trx.payment_status),
      subtotal: Number(trx.subtotal) || 0,
      discount_total: Number(trx.discount_total) || 0,
      grand_total: Number(trx.grand_total) || 0,
      paid_total: Number(trx.paid_total) || 0,
      outstanding: Number(trx.outstanding) || 0,
      revision: Number(trx.revision) || 0,
      item_count: items.length,
      dibatalkan: Util.isTrue(trx.is_void) || String(trx.stage_status) === 'DIBATALKAN',

      // Nomor nota pesanan indent tetap ditampilkan — itu yang
      // dipegang customer sebelum nota penjualan terbit
      nota_indent: String(trx.nota_indent || ''),

      /*
       * Email customer, untuk Kasir yang mengirim bukti bayar.
       * Diambil dari data customernya karena transaksi tidak
       * menyimpan salinannya.
       */
      cust_email: (function () {
        if (!trx.customer_id) return '';
        try {
          var c = Repo.findOne(DB.SHEET.CUSTOMERS, 'customer_id', trx.customer_id);
          return c ? String(c.email || '') : '';
        } catch (eE) { return ''; }
      })(),

      // Keterangan tempo, ditentukan Sales Online saat membuat pesanan
      tempo_hari: Number(trx.tempo_hari) || 0,
      tempo_jatuh: Util.dateStr(trx.tempo_jatuh),
      tempo_by: String(trx.tempo_by || ''),
      channel: String(trx.channel || 'RITEL'),
      bisa_bayar: (!!String(trx.nota_no || '').trim() ||
                   !!String(trx.nota_indent || '').trim()) &&
                  !Util.isTrue(trx.is_void) &&
                  String(trx.stage_status) !== 'DIBATALKAN'
    },
    items: items,
    payments: bacaPembayaran_(trxId),
    metode: METODE_BAYAR,
    bisaVoid: hasPerm_(session, 'PAYMENT_VOID')
  };
}

// ============================================================
// API — CATAT PEMBAYARAN
// ============================================================

function apiAddPayment(payload) {
  return withGuard_(payload, { permission: 'PAYMENT_ADD', lock: 'ringan' }, function (session) {
    var jam = Jam.mulai('apiAddPayment');
    var trx = Repo.findOne(DB.SHEET.TRX, 'trx_id', payload.trx_id);
    if (!trx) throw appErr_('NOT_FOUND', 'Transaksi tidak ditemukan.');
    if (Util.isTrue(trx.is_void)) throw appErr_('VOIDED', 'Transaksi ini sudah dibatalkan.');

    /*
     * Cukup salah satu nota.
     *
     * Pesanan indent dibayar dengan nota pesanan (SO-PWT) jauh sebelum
     * nota penjualan terbit. Kalau Kasir menunggu nota penjualan, DP
     * pesanan indent tidak punya tempat untuk dicatat.
     */
    if (!String(trx.nota_no || '').trim() && !String(trx.nota_indent || '').trim()) {
      throw appErr_('NO_NOTA',
        'Pembayaran belum bisa dicatat karena belum ada nomor nota. Hubungi Admin.');
    }

    if (payload.revision !== undefined && payload.revision !== null && payload.revision !== '') {
      if (Number(payload.revision) !== (Number(trx.revision) || 0)) {
        throw appErr_('STALE_DATA',
          'Transaksi sudah diperbarui oleh ' + (trx.updated_by_name || 'orang lain') +
          '. Layar dimuat ulang supaya angkanya benar.');
      }
    }

    var nominal = Math.round(Number(payload.amount) || 0);
    if (!(nominal > 0)) throw appErr_('BAD_AMOUNT', 'Nominal pembayaran harus lebih dari 0.');

    var metode = String(payload.method || '').toUpperCase();
    if (METODE_BAYAR.indexOf(metode) < 0) {
      throw appErr_('BAD_METHOD', 'Metode pembayaran tidak dikenal.');
    }

    var kondisi = hitungPembayaran_(trx.trx_id);
    var total = kondisi.total;
    var sudah = kondisi.masuk;
    var sisa = total - sudah;

    if (sisa <= 0) {
      throw appErr_('ALREADY_PAID', 'Transaksi ini sudah lunas. Tidak ada sisa yang perlu dibayar.');
    }

    // Kelebihan bayar biasanya salah ketik. Super Admin boleh menembusnya
    // untuk kasus khusus, tapi harus sadar melakukannya.
    if (nominal > sisa && !Util.isTrue(payload.izinkan_lebih)) {
      var e = appErr_('OVER_PAY',
        'Nominal ' + formatRp_(nominal) + ' melebihi sisa tagihan ' + formatRp_(sisa) + '.');
      e.details = { sisa: sisa, nominal: nominal, boleh_lebih: hasPerm_(session, 'GUARD_OVERRIDE') };
      throw e;
    }
    if (nominal > sisa && !hasPerm_(session, 'GUARD_OVERRIDE')) {
      throw appErr_('FORBIDDEN', 'Hanya Super Admin yang boleh mencatat kelebihan bayar.');
    }

    var jenis = (sudah <= 0 && nominal >= total) ? 'FULL'
              : (sudah > 0 ? 'PELUNASAN' : 'DP');

    // Riwayat pembayaran dibaca sekali, lalu dipakai ulang
    var bayarLama = Repo.findManyFast(DB.SHEET.PAYMENTS, 'trx_id', trx.trx_id);
    var urut = bayarLama.length + 1;
    var now = nowIso_();

    jam.tandai('baca transaksi & pembayaran');

    var barisBaru = {
      payment_id: Util.id('PAY'), trx_id: trx.trx_id, trx_no: trx.trx_no,
      seq: urut, type: jenis, amount: nominal, method: metode,
      ref_no: String(payload.ref_no || '').trim(),
      paid_at: now,
      cashier_user_id: session.user_id, cashier_name: session.full_name,
      note: String(payload.note || '').trim(),
      is_void: false, created_at: now
    };

    Repo.append(DB.SHEET.PAYMENTS, barisBaru);

    /*
     * Perhitungan memakai daftar yang sudah ada di memori ditambah
     * baris yang baru saja ditulis — bukan membaca ulang sheetnya.
     *
     * Penulisan barusan membatalkan salinan, jadi pembacaan berikutnya
     * mengambil seluruh isi sheet dari nol. Dari pengukuran, itu dua
     * detik dari tiga detik total.
     */
    var setelah = hitungPembayaran_(trx.trx_id, bayarLama.concat([barisBaru]), trx);
    var lunasBaru = setelah.status === 'LUNAS' && kondisi.status !== 'LUNAS';

    var trx2 = Repo.findOne(DB.SHEET.TRX, 'trx_id', trx.trx_id);
    var patch = {};

    /*
     * Lunas tidak selalu berarti siap diaktivasi.
     *
     * Pesanan indent bisa dibayar lunas di muka sementara barangnya
     * belum datang. Kalau tahapnya langsung dilompatkan ke Teknisi,
     * Teknisi menunggu barang yang belum ada di tempat.
     */
    if (lunasBaru && String(trx2.stage_status) === 'MENUNGGU_PEMBAYARAN') {
      /*
       * Setelah lunas, belum tentu ke Teknisi.
       *
       * Pesanan online sering tidak ada yang perlu dikerjakan Teknisi
       * — beli mouse, tas, atau tinta. Memaksanya lewat sana berarti
       * Teknisi menekan tiga tombol untuk barang yang cuma lewat, dan
       * customer menunggu antrian yang tidak ada gunanya.
       *
       * Yang menentukan Eksekusi saat menyiapkan, karena dia yang
       * memegang barangnya dan tahu isinya apa.
       */
      patch.stage_status = perluTeknisi_(trx2) ? 'MENUNGGU_AKTIVASI' : 'SIAP_SERAH';
    }
    bumpRevision_(session, trx2, patch);

    logAudit_(session, {
      entity: 'PAYMENT', entity_id: trx.trx_no, trx_no: trx.trx_no,
      action: 'CREATE', field: jenis.toLowerCase(),
      old_value: 'terbayar ' + sudah, new_value: 'terbayar ' + setelah.masuk +
        ' (' + metode + (payload.ref_no ? ' ' + payload.ref_no : '') + ')',
      reason: payload.note || ''
    });
    logTimeline_(session, {
      trx_id: trx.trx_id, trx_no: trx.trx_no,
      event_code: 'PAYMENT_' + jenis,
      stage_after: patch.stage_status || String(trx2.stage_status),
      event_label: 'Kasir ' + session.full_name + ' mencatat ' +
        (jenis === 'DP' ? 'DP' : (jenis === 'PELUNASAN' ? 'pelunasan' : 'pembayaran')) + ' ' +
        formatRp_(nominal),
      detail: metode + (payload.ref_no ? ' · ' + payload.ref_no : '') +
        ' · sisa ' + formatRp_(setelah.sisa)
    });

    if (lunasBaru && (patch.stage_status === 'MENUNGGU_AKTIVASI' ||
                      patch.stage_status === 'SIAP_SERAH')) {
      pushNotif_({
        target_role: 'TEKNISI', target_branch: trx.branch,
        trx_id: trx.trx_id, trx_no: trx.trx_no,
        type: 'PAID', priority: 'HIGH',
        title: 'Siap aktivasi',
        body: trx.trx_no + ' · ' + trx.cust_name_snap + ' · lunas ' + formatRp_(setelah.masuk)
      });
      pushNotif_({
        target_role: 'SALES', target_branch: trx.branch,
        trx_id: trx.trx_id, trx_no: trx.trx_no,
        type: 'PAID', priority: 'NORMAL',
        title: 'Transaksi lunas',
        body: trx.trx_no + ' · ' + trx.cust_name_snap
      });
    } else if (setelah.status === 'DP') {
      pushNotif_({
        target_role: 'ADMIN', target_branch: trx.branch,
        trx_id: trx.trx_id, trx_no: trx.trx_no,
        type: 'PAID', priority: 'NORMAL',
        title: 'DP diterima',
        body: trx.trx_no + ' · ' + formatRp_(nominal) + ' · sisa ' + formatRp_(setelah.sisa)
      });
    }

    /*
     * Kalau sudah lunas, layar Kasir langsung kembali ke antrian.
     * Membaca ulang rincian transaksi untuk layar yang ditinggalkan
     * hanya menambah satu sampai dua detik tanpa ada yang memakainya.
     */
    jam.tandai('hitung ulang & ubah tahap');

    if (lunasBaru) {
      jam.selesai();
      return {
        ringkas: true, lunasBaru: true,
        trx_no: String(trx.trx_no),
        terbayar: setelah.terbayar, sisa: setelah.sisa
      };
    }

    var hasil = dataKasir_(session, trx.trx_id);
    hasil.lunasBaru = false;
    jam.tandai('baca ulang untuk layar');
    jam.selesai();
    return hasil;
  });
}

// ============================================================
// API — BATALKAN PEMBAYARAN
// ============================================================

function apiVoidPayment(payload) {
  return withGuard_(payload, { permission: 'PAYMENT_VOID', lock: true }, function (session) {
    var pay = Repo.findOne(DB.SHEET.PAYMENTS, 'payment_id', payload.payment_id);
    if (!pay) throw appErr_('NOT_FOUND', 'Data pembayaran tidak ditemukan.');
    if (Util.isTrue(pay.is_void)) throw appErr_('ALREADY', 'Pembayaran ini sudah dibatalkan.');

    var alasan = String(payload.reason || '').trim();
    if (alasan.length < 4) {
      throw appErr_('NO_REASON', 'Alasan pembatalan wajib diisi, minimal beberapa kata.');
    }

    var now = nowIso_();
    Repo.update(DB.SHEET.PAYMENTS, pay._row, {
      is_void: true, void_reason: alasan,
      void_by: session.full_name, void_at: now
    });

    var setelah = hitungPembayaran_(pay.trx_id);
    var trx2 = Repo.findOne(DB.SHEET.TRX, 'trx_id', pay.trx_id);
    var patch = {};

    // Kalau jadi tidak lunas lagi, transaksi ditarik kembali ke Kasir
    if (setelah.status !== 'LUNAS' && String(trx2.stage_status) === 'MENUNGGU_AKTIVASI') {
      patch.stage_status = 'MENUNGGU_PEMBAYARAN';
    }
    bumpRevision_(session, trx2, patch);

    logAudit_(session, {
      entity: 'PAYMENT', entity_id: String(pay.payment_id), trx_no: String(pay.trx_no),
      action: 'VOID', field: 'amount',
      old_value: String(pay.amount), new_value: '(dibatalkan)', reason: alasan
    });
    logTimeline_(session, {
      trx_id: String(pay.trx_id), trx_no: String(pay.trx_no),
      event_code: 'PAYMENT_VOID',
      stage_after: patch.stage_status || String(trx2.stage_status),
      event_label: session.full_name + ' membatalkan pembayaran ' + formatRp_(pay.amount),
      detail: alasan + ' · sisa sekarang ' + formatRp_(setelah.sisa)
    });

    if (patch.stage_status) {
      pushNotif_({
        target_role: 'KASIR', target_branch: trx2.branch,
        trx_id: trx2.trx_id, trx_no: trx2.trx_no,
        type: 'PAID', priority: 'HIGH',
        title: 'Transaksi kembali belum lunas',
        body: trx2.trx_no + ' · pembayaran dibatalkan · sisa ' + formatRp_(setelah.sisa)
      });
    }

    return dataKasir_(session, String(pay.trx_id));
  });
}

// ============================================================
// API — KOREKSI CATATAN PEMBAYARAN
//
// Kasir boleh membetulkan nomor referensi dan catatan, tapi TIDAK
// nominalnya. Nomor struk EDC yang salah ketik perlu bisa dibetulkan
// tanpa merepotkan siapa-siapa; jumlah uang yang sudah tercatat
// adalah hal yang berbeda — itu hanya boleh dibatalkan Super Admin,
// dengan alasan, dan barisnya tetap terlihat.
// ============================================================

function apiUpdatePaymentNote(payload) {
  return withGuard_(payload, { permission: 'PAYMENT_ADD', lock: true }, function (session) {
    var pay = Repo.findOne(DB.SHEET.PAYMENTS, 'payment_id', payload.payment_id);
    if (!pay) throw appErr_('NOT_FOUND', 'Data pembayaran tidak ditemukan.');
    if (Util.isTrue(pay.is_void)) throw appErr_('VOIDED', 'Pembayaran ini sudah dibatalkan.');

    var refBaru = String(payload.ref_no === undefined ? pay.ref_no : payload.ref_no).trim();
    var noteBaru = String(payload.note === undefined ? pay.note : payload.note).trim();
    var metodeBaru = String(payload.method || pay.method).toUpperCase();

    if (METODE_BAYAR.indexOf(metodeBaru) < 0) {
      throw appErr_('BAD_METHOD', 'Metode pembayaran tidak dikenal.');
    }

    var ubah = [];
    if (refBaru !== String(pay.ref_no || '')) ubah.push('nomor referensi');
    if (noteBaru !== String(pay.note || '')) ubah.push('catatan');
    if (metodeBaru !== String(pay.method || '')) ubah.push('metode');

    if (!ubah.length) return { changed: 0 };

    Repo.update(DB.SHEET.PAYMENTS, pay._row, {
      ref_no: refBaru, note: noteBaru, method: metodeBaru
    });

    logAudit_(session, {
      entity: 'PAYMENT', entity_id: String(pay.payment_id), trx_no: String(pay.trx_no),
      action: 'UPDATE', field: ubah.join(','),
      old_value: String(pay.method) + ' ' + String(pay.ref_no || '') +
                 (pay.note ? ' · ' + pay.note : ''),
      new_value: metodeBaru + ' ' + refBaru + (noteBaru ? ' · ' + noteBaru : ''),
      reason: payload.reason || ''
    });
    logTimeline_(session, {
      trx_id: String(pay.trx_id), trx_no: String(pay.trx_no),
      event_code: 'PAYMENT_EDIT', stage_after: '',
      event_label: session.full_name + ' membetulkan catatan pembayaran ' +
                   formatRp_(pay.amount),
      detail: ubah.join(', ') + ' diperbarui'
    });

    return { changed: 1 };
  });
}

// ============================================================
// API — RIWAYAT PEMBAYARAN
// ============================================================

function apiRiwayatBayar(payload) {
  return withGuard_(payload, { permission: 'PAYMENT_VIEW_DETAIL' }, function (session) {
    var hari = Number(payload.hari === undefined ? 7 : payload.hari);
    var q = String(payload.q || '').trim().toUpperCase();
    var semuaCabang = hasPerm_(session, 'TRX_VIEW_ALL');

    var batas = new Date();
    batas.setDate(batas.getDate() - hari);
    var batasMs = batas.getTime();

    var cabang = {};
    Repo.columns(DB.SHEET.TRX, ['trx_id', 'branch', 'cust_name_snap', 'nota_no'])
      .forEach(function (t) {
        cabang[String(t.trx_id)] = {
          branch: String(t.branch), cust: String(t.cust_name_snap),
          nota: String(t.nota_no || '')
        };
      });

    var rows = Repo.all(DB.SHEET.PAYMENTS);
    var out = [], rekap = { masuk: 0, jumlah: 0, perMetode: {} };

    for (var i = 0; i < rows.length; i++) {
      var p = rows[i];
      var info = cabang[String(p.trx_id)] || { branch: '', cust: '', nota: '' };
      if (!semuaCabang && info.branch && info.branch !== String(session.branch)) continue;

      if (hari > 0) {
        var w = new Date(Util.isoStr(p.paid_at)).getTime();
        if (isNaN(w) || w < batasMs) continue;
      }

      if (q) {
        var bahan = [p.trx_no, info.cust, info.nota, p.method, p.ref_no, p.cashier_name]
                    .join(' ').toUpperCase();
        if (bahan.indexOf(q) < 0) continue;
      }

      var nominal = Number(p.amount) || 0;
      var batal = Util.isTrue(p.is_void);

      if (!batal) {
        var arah = String(p.type) === 'REFUND' ? -1 : 1;
        rekap.masuk += nominal * arah;
        rekap.jumlah++;
        var m = String(p.method || 'LAIN');
        rekap.perMetode[m] = (rekap.perMetode[m] || 0) + nominal * arah;
      }

      out.push({
        payment_id: String(p.payment_id), trx_id: String(p.trx_id),
        trx_no: String(p.trx_no), nota_no: info.nota, cust_name: info.cust,
        type: String(p.type), amount: nominal, method: String(p.method || ''),
        ref_no: String(p.ref_no || ''), paid_at: Util.isoStr(p.paid_at),
        cashier_name: String(p.cashier_name || ''), note: String(p.note || ''),
        is_void: batal, void_reason: String(p.void_reason || '')
      });
    }

    out.sort(function (a, b) { return a.paid_at < b.paid_at ? 1 : -1; });
    return {
      list: out.slice(0, 200), total: out.length, rekap: rekap,
      metode: METODE_BAYAR,
      bisaVoid: hasPerm_(session, 'PAYMENT_VOID')
    };
  });
}

// ============================================================
// PENJUALAN TEMPO
//
// Aturan dasar sistem ini: barang tidak keluar sebelum lunas. Itu
// yang menjaga tidak ada barang hilang tanpa catatan.
//
// Tempo melanggar aturan itu secara sah — instansi tertentu memang
// membayar belakangan. Jadi bukan aturannya yang dilonggarkan untuk
// semua orang, melainkan disediakan jalur tersendiri yang tercatat:
// siapa yang menyetujui, kapan jatuh temponya, dan pesanannya tetap
// berdiri di daftar Kasir sampai benar-benar dibayar.
//
// Berapa harinya ditentukan Sales Online saat membuat pesanan,
// karena dia yang memegang perjanjian dengan instansinya.
// ============================================================

function apiTandaiTempo(payload) {
  return withGuard_(payload, { permission: 'PAYMENT_ADD', lock: 'ringan' }, function (session) {
    var trx = Repo.findOne(DB.SHEET.TRX, 'trx_id', payload.trx_id);
    if (!trx) throw appErr_('NOT_FOUND', 'Transaksi tidak ditemukan.');
    if (Util.isTrue(trx.is_void)) throw appErr_('VOIDED', 'Transaksi ini sudah dibatalkan.');

    /*
     * Tahap yang boleh dibayar.
     *
     * Kalau pengaturan "Teknisi sebelum Kasir" dinyalakan, pesanan
     * sudah berada di antrian Teknisi saat pembayarannya menyusul —
     * jadi menolak berdasarkan tahap justru menahan pekerjaan yang
     * memang dimaksudkan berjalan duluan.
     *
     * Yang menentukan bukan tahapnya, melainkan masih ada tagihan
     * atau tidak.
     */
    var bolehBayar = ['MENUNGGU_PEMBAYARAN', 'MENUNGGU_AKTIVASI',
                      'PROSES_AKTIVASI', 'AKTIVASI_SELESAI', 'SIAP_SERAH'];

    if (bolehBayar.indexOf(String(trx.stage_status)) < 0) {
      throw appErr_('STAGE_LOCKED',
        'Transaksi ini tidak sedang menunggu pembayaran. Status sekarang: ' +
        stageLabel_(trx.stage_status) + '.');
    }

    var hari = Number(trx.tempo_hari) || Number(payload.hari) || 0;
    if (hari <= 0) {
      throw appErr_('NO_TEMPO',
        'Pesanan ini tidak ditandai tempo oleh Sales. Kalau memang tempo, ' +
        'minta Sales Online membetulkannya dulu — dia yang memegang perjanjiannya.');
    }

    if (String(trx.nota_no || '').trim() === '') {
      throw appErr_('NO_NOTA',
        'Notanya belum terbit. Barang tempo tetap harus bernota sebelum keluar.');
    }

    var now = nowIso_();
    var jatuh = new Date();
    jatuh.setDate(jatuh.getDate() + hari);
    var jatuhStr = Utilities.formatDate(jatuh, 'Asia/Jakarta', 'yyyy-MM-dd');

    /*
     * Status pembayaran TIDAK diubah.
     *
     * Status itu dihitung dari riwayat pembayaran, dan memang belum
     * ada yang dibayar. Memalsukannya jadi "lunas" akan merusak
     * laporan dan membuat piutang menghilang dari pandangan.
     *
     * Yang berubah cuma tahapnya — barang boleh jalan — dan tanggal
     * jatuh temponya tercatat.
     */
    var tahapBaru = (typeof perluTeknisi_ === 'function' && perluTeknisi_(trx))
      ? 'MENUNGGU_AKTIVASI' : 'SIAP_SERAH';

    bumpRevision_(session, trx, {
      stage_status: tahapBaru,
      tempo_jatuh: jatuhStr,
      tempo_by: session.full_name
    });

    logAudit_(session, {
      entity: 'TRX', entity_id: trx.trx_id, trx_no: trx.trx_no,
      action: 'STAGE_CHANGE', field: 'tempo',
      old_value: 'MENUNGGU_PEMBAYARAN', new_value: 'Tempo ' + hari + ' hari',
      reason: String(payload.catatan || '')
    });

    logTimeline_(session, {
      trx_id: trx.trx_id, trx_no: trx.trx_no,
      event_code: 'TEMPO', stage_after: tahapBaru,
      event_label: session.full_name + ' menandai pembayaran tempo ' + hari + ' hari',
      detail: 'Jatuh tempo ' + jatuhStr +
        (payload.catatan ? ' · ' + payload.catatan : '')
    });

    pushNotif_({
      target_role: tahapBaru === 'MENUNGGU_AKTIVASI' ? 'TEKNISI' : 'EKSEKUSI',
      target_branch: trx.branch,
      trx_id: trx.trx_id, trx_no: trx.trx_no,
      type: 'PAID', priority: 'HIGH',
      title: 'Tempo disetujui — barang boleh jalan',
      body: trx.trx_no + ' · ' + String(trx.cust_name_snap) +
        ' · jatuh tempo ' + jatuhStr
    });

    flushLog_();

    return {
      ok: true, trx_no: String(trx.trx_no), jatuh: jatuhStr,
      pesan: 'Tempo ' + hari + ' hari dicatat. Jatuh tempo ' + jatuhStr +
             '. Tagihannya tetap ada di daftar Tempo Berjalan.'
    };
  });
}

/** Daftar piutang tempo yang belum lunas */
function apiTempoBerjalan(payload) {
  /*
   * Dijaga dengan izin yang memang dimiliki Kasir.
   *
   * Sebelumnya memakai PAYMENT_VIEW_SUMMARY — izin yang dipunyai
   * Sales dan Admin, tapi bukan Kasir. Akibatnya daftar tempo
   * kosong di satu-satunya tempat yang membutuhkannya.
   */
  return withGuard_(payload, { permission: 'PAYMENT_ADD' }, function (session) {
    if (Util.isTrue(payload.segar)) {
      try { Repo.bustSheet(DB.SHEET.TRX); } catch (eB) {}
    }

    var semuaCabang = hasPerm_(session, 'TRX_VIEW_ALL');
    var hariIni = Util.todayStr();
    var out = [];

    Repo.columns(DB.SHEET.TRX, [
      'trx_id', 'trx_no', 'branch', 'trx_date', 'cust_name_snap', 'cust_phone_snap',
      'sales_name', 'stage_status', 'payment_status', 'grand_total', 'paid_total',
      'outstanding', 'nota_no', 'tempo_hari', 'tempo_jatuh', 'tempo_by',
      'channel', 'is_void'
    ]).forEach(function (t) {
      if (Util.isTrue(t.is_void)) return;
      /*
       * Dua-duanya masuk daftar: tempo yang sudah disetujui, dan
       * yang baru diminta Sales.
       *
       * Sebelumnya hanya yang sudah disetujui. Akibatnya nota tempo
       * yang baru terbit tidak ketemu di mana pun — padahal justru
       * itu yang dicari Kasir untuk diproses.
       */
      var jatuhT = Util.dateStr(t.tempo_jatuh);
      var mintaT = Number(t.tempo_hari) || 0;
      if (!jatuhT && !mintaT) return;

      /*
       * Sisa tagihan dihitung, bukan sekadar dibaca.
       *
       * Kolom sisa baru terisi setelah ada pembayaran pertama. Untuk
       * tempo yang belum dibayar sama sekali, kolomnya kosong — dan
       * membacanya apa adanya membuat seluruh daftar tempo terlihat
       * lunas, lalu kosong.
       */
      var sisaT = Number(t.outstanding) || 0;
      if (sisaT <= 0) {
        sisaT = (Number(t.grand_total) || 0) - (Number(t.paid_total) || 0);
      }
      if (sisaT <= 0) return;      // benar-benar sudah lunas
      if (!semuaCabang && String(t.branch) !== String(session.branch)) return;

      /*
       * Tanggalnya dibentuk ulang jadi yyyy-MM-dd.
       *
       * Spreadsheet mengembalikan kolom tanggal sebagai objek waktu
       * lengkap, dan kalau langsung dijadikan teks hasilnya seperti
       * "Sun Nov 01 2026 00:00:00 GMT+0700" — menabrak di layar dan
       * tidak terbaca siapa pun.
       */
      var jatuh = jatuhT;
      var lewat = !!jatuh && jatuh < hariIni;

      out.push({
        trx_id: String(t.trx_id), trx_no: String(t.trx_no),
        tanggal: Util.dateStr(t.trx_date),
        cust_name: String(t.cust_name_snap), cust_phone: Util.hp(t.cust_phone_snap),
        sales_name: String(t.sales_name || ''),
        nota_no: String(t.nota_no || ''),
        grand_total: Number(t.grand_total) || 0,
        paid_total: Number(t.paid_total) || 0,
        outstanding: sisaT,
        tempo_hari: Number(t.tempo_hari) || 0,
        jatuh: jatuh, lewat: lewat,
        disetujui: String(t.tempo_by || ''),
        menunggu_setuju: !jatuh,
        stage_label: stageLabel_(t.stage_status),
        channel: String(t.channel || 'RITEL')
      });
    });

    /*
     * Urutannya: yang lewat jatuh tempo dulu, lalu yang menunggu
     * persetujuan, baru sisanya menurut tanggal jatuh tempo.
     */
    out.sort(function (a, b) {
      if (a.lewat !== b.lewat) return a.lewat ? -1 : 1;
      if (a.menunggu_setuju !== b.menunggu_setuju) return a.menunggu_setuju ? -1 : 1;
      return String(a.jatuh) < String(b.jatuh) ? -1 : 1;
    });

    return {
      list: out, total: out.length,
      lewat: out.filter(function (x) { return x.lewat; }).length,
      nilai: out.reduce(function (n, x) { return n + x.outstanding; }, 0)
    };
  });
}

/**
 * Menyelesaikan transaksi tanpa tagihan.
 *
 * Nilainya nol, jadi tidak ada yang bisa dibayarkan — form
 * pembayaran menolak angka nol, dan transaksinya tertahan di Kasir
 * selamanya sampai barangnya tidak pernah sampai ke customer.
 *
 * Sebabnya bermacam-macam: barang bonus yang notanya dipisah,
 * potongan penuh, unit pengganti. Yang dicatat keadaannya saja
 * beserta keterangan dari Kasir — menebak sebabnya di kode berarti
 * salah untuk sebagian kasus.
 *
 * Tetap lewat Kasir, bukan dilewati: barang yang keluar tanpa uang
 * masuk justru yang paling perlu jejak.
 */
function apiSelesaikanNol(payload) {
  return withGuard_(payload, { permission: 'PAYMENT_ADD', lock: 'ringan' }, function (session) {
    var trx = Repo.findOne(DB.SHEET.TRX, 'trx_id', payload.trx_id);
    if (!trx) throw appErr_('NOT_FOUND', 'Transaksi tidak ditemukan.');
    if (Util.isTrue(trx.is_void)) throw appErr_('VOIDED', 'Transaksi ini sudah dibatalkan.');

    var total = Number(trx.grand_total) || 0;
    var dibayar = Number(trx.paid_total) || 0;
    var sisa = total - dibayar;

    if (sisa > 0) {
      throw appErr_('ADA_TAGIHAN',
        'Transaksi ini masih bernilai ' + formatRp_(sisa) +
        '. Catat pembayarannya seperti biasa.');
    }

    /*
     * Tahap yang boleh dibayar.
     *
     * Kalau pengaturan "Teknisi sebelum Kasir" dinyalakan, pesanan
     * sudah berada di antrian Teknisi saat pembayarannya menyusul —
     * jadi menolak berdasarkan tahap justru menahan pekerjaan yang
     * memang dimaksudkan berjalan duluan.
     *
     * Yang menentukan bukan tahapnya, melainkan masih ada tagihan
     * atau tidak.
     */
    var bolehBayar = ['MENUNGGU_PEMBAYARAN', 'MENUNGGU_AKTIVASI',
                      'PROSES_AKTIVASI', 'AKTIVASI_SELESAI', 'SIAP_SERAH'];

    if (bolehBayar.indexOf(String(trx.stage_status)) < 0) {
      throw appErr_('STAGE_LOCKED',
        'Transaksi ini tidak sedang menunggu pembayaran. Status sekarang: ' +
        stageLabel_(trx.stage_status) + '.');
    }

    if (!String(trx.nota_no || '').trim() && !String(trx.nota_indent || '').trim()) {
      throw appErr_('NO_NOTA', 'Notanya belum terbit.');
    }

    var now = nowIso_();
    var tahapBaru = (typeof perluTeknisi_ === 'function' && perluTeknisi_(trx))
      ? 'MENUNGGU_AKTIVASI' : 'SIAP_SERAH';

    bumpRevision_(session, trx, {
      stage_status: tahapBaru,
      payment_status: 'LUNAS',
      paid_total: dibayar,
      outstanding: 0,
      paid_at: trx.paid_at || now
    });

    logAudit_(session, {
      entity: 'TRX', entity_id: trx.trx_id, trx_no: trx.trx_no,
      action: 'STAGE_CHANGE', field: 'nilai_nol',
      old_value: 'MENUNGGU_PEMBAYARAN', new_value: tahapBaru,
      reason: String(payload.catatan || 'Nota tanpa tagihan')
    });

    logTimeline_(session, {
      trx_id: trx.trx_id, trx_no: trx.trx_no,
      event_code: 'PAID', stage_after: tahapBaru,
      event_label: session.full_name + ' menyelesaikan nota tanpa tagihan',
      detail: String(payload.catatan || 'Nilainya nol, tidak ada yang ditagih')
    });

    pushNotif_({
      target_role: tahapBaru === 'MENUNGGU_AKTIVASI' ? 'TEKNISI' : 'EKSEKUSI',
      target_branch: trx.branch,
      trx_id: trx.trx_id, trx_no: trx.trx_no,
      type: 'PAID', priority: 'HIGH',
      title: 'Nota tanpa tagihan diselesaikan',
      body: trx.trx_no + ' · ' + String(trx.cust_name_snap) +
        (payload.catatan ? ' · ' + String(payload.catatan) : '')
    });

    flushLog_();

    return { ok: true, trx_no: String(trx.trx_no), pesan: 'Transaksi diselesaikan.' };
  });
}
