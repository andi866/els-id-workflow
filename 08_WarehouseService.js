/**
 * ELS.ID WORKFLOW SYSTEM — Phase 3 (v3)
 * File : 08_WarehouseService.gs
 *
 * Perubahan penting dari v2:
 * Serial Number tidak lagi disimpan satu per satu sambil diketik.
 * Seluruh SN dikirim sekaligus saat Gudang menekan Konfirmasi barang siap.
 *
 * Alasannya: menyimpan per kotak berarti layar harus dimuat ulang setiap
 * kali satu SN masuk, dan itu menghapus kotak lain yang sedang diketik.
 * Sekarang satu pesanan = satu kali simpan, berapa pun jumlah unitnya.
 *
 * Aturan yang tetap dipegang:
 * - SN tidak wajib untuk semua barang.
 * - Satu SN tidak boleh dipakai di dua transaksi sekaligus.
 * - SN yang diganti tidak dihapus, hanya dinonaktifkan beserta alasannya.
 * - Gudang tidak bisa mengubah barang, jumlah, atau harga.
 */

// ============================================================
// PEMBACA TRANSAKSI UNTUK GUDANG
// ============================================================

function loadTrxForGudang_(session, trxId, expectedRevision) {
  var trx = Repo.findOne(DB.SHEET.TRX, 'trx_id', trxId);
  if (!trx) throw appErr_('NOT_FOUND', 'Transaksi tidak ditemukan.');
  if (Util.isTrue(trx.is_void)) throw appErr_('VOIDED', 'Transaksi ini sudah dibatalkan.');

  if (String(trx.branch) !== String(session.branch) && !hasPerm_(session, 'TRX_VIEW_ALL')) {
    throw appErr_('OTHER_BRANCH', 'Pesanan ini milik cabang lain.');
  }

  var stage = String(trx.stage_status);
  if (['MENUNGGU_GUDANG', 'PROSES_GUDANG'].indexOf(stage) < 0) {
    throw appErr_('STAGE_LOCKED',
      'Pesanan ini sudah pada tahap "' + stageLabel_(stage) + '", bukan lagi di Gudang.');
  }

  if (expectedRevision !== undefined && expectedRevision !== null && expectedRevision !== '') {
    if (Number(expectedRevision) !== (Number(trx.revision) || 0)) {
      throw appErr_('STALE_DATA',
        'Pesanan sudah diperbarui oleh ' + (trx.updated_by_name || 'orang lain') +
        '. Cek ulang daftar barangnya — SN yang sudah Anda pindai tidak hilang.');
    }
  }
  return trx;
}

function buildGudangState_(session, trxId) {
  var trx = Repo.findOne(DB.SHEET.TRX, 'trx_id', trxId);
  if (!trx) throw appErr_('NOT_FOUND', 'Transaksi tidak ditemukan.');

  var snRows = Repo.findManyFast(DB.SHEET.SN, 'trx_id', trxId)
                   .filter(function (s) { return Util.isTrue(s.is_active); });

  var snPerItem = {};
  snRows.forEach(function (s) {
    var k = String(s.item_id);
    if (!snPerItem[k]) snPerItem[k] = {};
    snPerItem[k][Number(s.unit_seq)] = String(s.serial_number);
  });

  /*
   * Gudang hanya melihat barang yang diminta Eksekusi.
   *
   * Pesanan online bisa berisi sepuluh barang, sembilan di antaranya
   * sudah di tangan Eksekusi. Menampilkan semuanya membuat Gudang
   * mencari-cari mana yang sebenarnya diminta — dan berisiko
   * menyiapkan barang yang sudah disiapkan orang lain.
   */
  var hanyaItem = null;
  if (String(session.role) === 'GUDANG' &&
      String(trx.channel || '').toUpperCase() === 'ONLINE') {
    try {
      bacaMintaSn_(trx).forEach(function (m) {
        if (String(m.status) !== 'MENUNGGU') return;
        hanyaItem = {};
        (m.barang || []).forEach(function (b) { hanyaItem[String(b.item_id)] = true; });
      });
    } catch (eH) {}
  }

  var items = Repo.findManyFast(DB.SHEET.ITEMS, 'trx_id', trxId)
    .filter(function (i) {
      if (!Util.isTrue(i.is_active)) return false;
      if (hanyaItem && !hanyaItem[String(i.item_id)]) return false;
      return true;
    })
    .sort(function (a, b) { return Number(a.line_no) - Number(b.line_no); })
    .map(function (i) {
      var qty = Number(i.qty) || 0;
      var daftar = snPerItem[String(i.item_id)] || {};

      var sns = [];
      for (var u = 1; u <= qty; u++) sns.push(daftar[u] || '');

      // Semua barang boleh diisi SN. Yang ditandai hanya diperingatkan
      // kalau dikosongkan — tidak ada yang diblokir.
      var saran = saranSn_(i.product_code, i.product_name,
                           i.need_sn === '' ? undefined : i.need_sn);

      return {
        item_id: String(i.item_id), line_no: Number(i.line_no),
        product_code: String(i.product_code), product_name: String(i.product_name),
        source: String(i.source), qty: qty,
        need_sn: saran.perlu, alasan_sn: saran.alasan, sns: sns,
        item_note: String(i.item_note || '')
      };
    });

  /*
   * Daftar nama yang muncul mengikuti divisi yang membuka.
   *
   * Inilah yang terlewat: layar detailnya membawa daftar petugasnya
   * sendiri, jadi memperbaiki fungsi daftar petugas saja tidak cukup
   * — Eksekusi tetap mendapat nama-nama petugas gudang karena daftar
   * itu sudah ikut terkirim bersama datanya.
   */
  var daftarPetugas = [];
  try {
    var eks = String(session.role) === 'EKSEKUSI';
    var sumber = eks ? daftarEksekusiIndex_() : daftarGudangIndex_();

    daftarPetugas = sumber
      .filter(function (p) { return p.a; })
      .map(function (p) { return { code: p.k, name: p.n }; })
      .sort(function (a, b) { return a.name < b.name ? -1 : 1; });
  } catch (e) {}

  return {
    petugas: daftarPetugas,
    header: {
      trx_id: String(trx.trx_id), trx_no: String(trx.trx_no),
      cust_name: String(trx.cust_name_snap), cust_phone: Util.hp(trx.cust_phone_snap),

      /*
       * Email customer, untuk yang perlu mengabarinya saat barang
       * siap atau dikirim. Diambil dari data customernya karena
       * transaksi tidak menyimpan salinannya.
       */
      cust_email: (function () {
        if (!trx.customer_id) return '';
        try {
          var c = Repo.findOne(DB.SHEET.CUSTOMERS, 'customer_id', trx.customer_id);
          return c ? String(c.email || '') : '';
        } catch (eE) { return ''; }
      })(),

      sales_name: String(trx.sales_name || ''), sales_code: String(trx.sales_code || ''),
      order_note: String(trx.order_note || ''),
      stage_status: String(trx.stage_status), stage_label: stageLabel_(trx.stage_status),
      revision: Number(trx.revision) || 0,
      confirmed_at: Util.isoStr(trx.sales_confirm_at),
      updated_at: Util.isoStr(trx.updated_at),
      updated_by_name: String(trx.updated_by_name || ''),
      item_count: items.length,
      total_qty: items.reduce(function (n, i) { return n + i.qty; }, 0),
      gudang_petugas: String(trx.gudang_petugas || ''),
      gudang_petugas_nama: String(trx.gudang_petugas_nama || ''),

      /*
       * Keterangan permintaan tembak SN.
       *
       * minta_sn_aktif  : Eksekusi sudah mengirim, menunggu Gudang.
       * hanya_sn        : layar ini dibuka Gudang untuk pesanan
       *                   online — tugasnya cuma mengisi SN.
       */
      channel: String(trx.channel || 'RITEL'),
      catatan_teknisi: String(trx.catatan_teknisi || ''),
      minta_sn_aktif: mintaSnTerbuka_(trx) > 0,
      hanya_sn: (String(session.role) === 'GUDANG' &&
                 String(trx.channel || '').toUpperCase() === 'ONLINE' &&
                 mintaSnTerbuka_(trx) > 0),
      revisi: (function () {
        var f = {};
        try { f = JSON.parse(String(trx.override_flags || '') || '{}'); } catch (e) {}
        return f.revisi ? { ringkas: String(f.revisi.ringkas || ''),
                            by: String(f.revisi.by || ''), at: String(f.revisi.at || '') } : null;
      })(),
      sn_perlu: items.reduce(function (n, i) { return n + (i.need_sn ? i.qty : 0); }, 0)
    },
    items: items
  };
}

// ============================================================
// API — ANTRIAN
// ============================================================

function apiGudangQueue(payload) {
  return withGuard_(payload, { permission: 'TRX_VIEW_STAGE' }, function (session) {
    var semuaCabang = hasPerm_(session, 'TRX_VIEW_ALL');
    var batasDiam = Settings.num('STUCK_ALERT_MIN', 30);
    var sekarang = new Date().getTime();

    var rows = Repo.columns(DB.SHEET.TRX, [
      'trx_id', 'trx_no', 'branch', 'cust_name_snap', 'cust_phone_snap',
      'sales_name', 'sales_code', 'stage_status', 'item_count', 'order_note',
      'sales_confirm_at', 'gudang_user_id', 'gudang_confirm_at',
      'channel', 'sumber', 'metode_serah', 'activation_done_at', 'nota_no',
      'gudang_petugas_nama', 'nota_indent', 'resep_print_count', 'item_count',
      'updated_at', 'updated_by_name', 'override_flags', 'is_void'
    ]);

    /*
     * Antrian dipisah menurut saluran, bukan menurut tahapan.
     *
     * Pesanan ritel disiapkan Gudang, pesanan online disiapkan Tim
     * Eksekusi. Pekerjaannya sama persis — cetak resep, ambil barang,
     * isi serial number — jadi tidak perlu tahapan baru. Yang perlu
     * dipisah cuma apa yang masing-masing lihat di layarnya.
     *
     * Super Admin melihat keduanya, karena dia yang memantau.
     */
    var peran = String(session.role);
    var hanya = '';
    if (peran === 'GUDANG') hanya = 'RITEL';
    else if (peran === 'EKSEKUSI') hanya = 'ONLINE';

    var out = [], jmlSerah = 0, jmlIndent = 0, jmlDraft = 0;
    for (var i = 0; i < rows.length; i++) {
      var t = rows[i];
      if (Util.isTrue(t.is_void)) continue;
      /*
       * Pesanan indent ikut berdiri di antrian.
       *
       * Barangnya belum datang, jadi belum ada yang bisa disiapkan —
       * tapi kalau tidak muncul sama sekali, yang memegangnya baru
       * ingat saat ada yang bertanya. Ditampilkan dengan penanda
       * tersendiri supaya tidak tertukar dengan pekerjaan hari ini.
       */
      var tahapQ = String(t.stage_status);

      /*
       * Dua tahap lain ikut dihitung walau tidak masuk daftar ini.
       *
       * Angkanya dipakai sebagai penanda di menu Menunggu Barang dan
       * Siap Diserahkan. Menghitungnya di sini lebih murah daripada
       * dua pembacaan sheet tambahan — datanya sudah di tangan.
       */
      if (tahapQ === 'SIAP_SERAH') { jmlSerah++; continue; }

      /*
       * Draft pesanan online ikut terlihat Tim Eksekusi.
       *
       * Sales Online sering membuat pesanan dari luar toko dan
       * belum mengonfirmasinya — menunggu customer memastikan.
       * Barangnya sudah bisa disiapkan sambil menunggu, dan
       * resepnya sudah bisa dicetak.
       *
       * Hanya draft yang sudah berisi barang: yang masih kosong
       * belum ada gunanya bagi siapa pun.
       */
      if (tahapQ === 'DRAFT') {
        if (hanya !== 'ONLINE') continue;
        if ((Number(t.item_count) || 0) < 1) continue;
        jmlDraft++;
      }

      if (['MENUNGGU_GUDANG', 'PROSES_GUDANG', 'MENUNGGU_BARANG', 'DRAFT']
            .indexOf(tahapQ) < 0) continue;
      if (tahapQ === 'MENUNGGU_BARANG') jmlIndent++;

      var ch = String(t.channel || 'RITEL').toUpperCase();

      /*
       * Gudang tetap melihat pesanan online YANG MEMINTA tembak SN.
       *
       * Barang ber-SN ada di gedung NB, dan yang menembaknya tetap
       * Gudang. Tanpa ini, Eksekusi harus menitip lewat WhatsApp yang
       * tidak tercatat di mana pun — dan kalau yang dititipi sedang
       * sibuk, permintaannya hilang begitu saja.
       *
       * Pesanannya tetap milik Eksekusi; Gudang cuma dipanggil untuk
       * mengisi SN, bukan untuk meneruskannya ke Admin.
       */
      var mintaSn = 0;
      try { mintaSn = mintaSnTerbuka_(t); } catch (eM) {}

      if (hanya === 'RITEL' && ch === 'ONLINE' && !mintaSn) continue;
      if (hanya === 'ONLINE' && ch !== 'ONLINE') continue;
      if (!semuaCabang && String(t.branch) !== String(session.branch)) continue;

      var mulai = t.sales_confirm_at ? new Date(Util.isoStr(t.sales_confirm_at)).getTime() : sekarang;
      var menit = Math.max(Math.round((sekarang - mulai) / 60000), 0);

      var flags = {};
      try { flags = JSON.parse(String(t.override_flags || '') || '{}'); } catch (e) {}
      var rev = (flags.revisi && !flags.revisi.dibaca) ? flags.revisi : null;

      /*
       * Penanda "diubah" tidak berlaku untuk pesanan indent.
       *
       * Penanda itu artinya isinya berubah setelah disiapkan, jadi
       * perlu dicek ulang. Pesanan indent belum pernah disiapkan —
       * barangnya saja belum datang. Dibiarkan bertanda, pesanannya
       * menggantung di tab Diubah dan tidak pernah bisa dibereskan.
       */
      if (tahapQ === 'MENUNGGU_BARANG') rev = null;

      out.push({
        revisi: rev ? { ringkas: String(rev.ringkas || ''), by: String(rev.by || ''),
                        at: String(rev.at || ''), fisik: !!rev.fisik } : null,
        trx_id: String(t.trx_id), trx_no: String(t.trx_no),
        cust_name: String(t.cust_name_snap), cust_phone: Util.hp(t.cust_phone_snap),
        sales_name: String(t.sales_name || ''),

        // Keterangan saluran, supaya Super Admin bisa membedakan dan
        // Eksekusi tahu pesanannya datang dari mana
        channel: String(t.channel || 'RITEL'),
        sumber: String(t.sumber || ''),
        metode_serah: String(t.metode_serah || ''),

        // Permintaan tembak SN yang masih menunggu
        minta_sn: mintaSn,

        /*
         * Barang dari Gudang yang sudah siap tapi belum dilihat
         * Eksekusi. Dihitung sebagai pekerjaan baru supaya alarmnya
         * berbunyi lewat jalur yang sama dengan pesanan baru —
         * bunyi tersendiri ternyata tidak selalu terdengar.
         */
        sn_siap: (function () {
          var n = 0;
          try {
            bacaMintaSn_(t).forEach(function (m) {
              if (String(m.status) === 'SELESAI' && !m.dilihat) n++;
            });
          } catch (eX) {}
          return n;
        })(),
        hanya_sn: (hanya === 'RITEL' && ch === 'ONLINE'),
        minta_sn_detail: (function () {
          var d = null;
          bacaMintaSn_(t).forEach(function (m) {
            if (String(m.status) === 'MENUNGGU') d = m;
          });
          if (!d) return null;
          return {
            id: String(d.id),
            oleh: String(d.minta_by || ''),
            at: String(d.minta_at || ''),
            catatan: String(d.catatan || ''),
            barang: (d.barang || []).map(function (b) {
              return {
                nama: String(b.product_name),
                qty: Number(b.qty) || 1,
                perlu_sn: !!b.perlu_sn
              };
            })
          };
        })(),

        stage_status: String(t.stage_status),
        indent: tahapQ === 'MENUNGGU_BARANG',
        draft: tahapQ === 'DRAFT',

        /*
         * Pesanan indent yang sudah ditangani tidak lagi "baru".
         *
         * Yang menandakan sudah ditangani: resepnya sudah dicetak,
         * penanggung jawabnya sudah dipilih, atau nota pesanannya
         * sudah terbit. Setelah itu tempatnya di menu Menunggu
         * Barang, bukan lagi di antrian pekerjaan hari ini.
         */
        ditangani: !!String(t.gudang_petugas_nama || '').trim() ||
                   !!String(t.nota_indent || '').trim() ||
                   (Number(t.resep_print_count) || 0) > 0,

        penyiap: String(t.gudang_petugas_nama || ''),

        /*
         * Sudah lewat Teknisi tapi belum bernota.
         *
         * Pesanan yang dikerjakan lebih dulu atas permintaan
         * customer kembali ke sini setelah Teknisi selesai. Tanpa
         * penanda, bentuknya sama dengan pesanan yang belum
         * disiapkan sama sekali.
         */
        dari_teknisi: !!t.activation_done_at && !String(t.nota_no || '').trim() &&
                      tahapQ === 'PROSES_GUDANG',

        /*
         * Pesanan indent hanya bisa dilihat, bukan dikerjakan.
         *
         * Barangnya belum datang, jadi tombol "mulai menyiapkan"
         * akan ditolak. Tapi isinya tetap perlu bisa dibuka — kalau
         * Sales bertanya isi pesanannya apa, jawabannya tidak boleh
         * "saya tidak bisa membukanya".
         */
        lihat_saja: tahapQ === 'MENUNGGU_BARANG' || tahapQ === 'DRAFT',
        item_count: Number(t.item_count) || 0,
        order_note: String(t.order_note || ''),
        confirmed_at: Util.isoStr(t.sales_confirm_at),
        waiting_min: menit,
        tertahan: menit >= batasDiam,
        updated_by_name: String(t.updated_by_name || '')
      });
    }

    out.sort(function (a, b) { return b.waiting_min - a.waiting_min; });

    return {
      list: out,
      indent: jmlIndent,
      serah: jmlSerah,
      draft: jmlDraft,
      /*
       * Pesanan indent ikut dihitung sebagai pesanan baru.
       *
       * Angka ini yang memicu alarm dan mengisi penanda di menu.
       * Barang indent memang belum bisa disiapkan, tapi resepnya
       * harus dicetak dan penanggung jawabnya ditentukan — kalau
       * tidak dihitung, tidak ada yang memberi tahu bahwa pesanan
       * itu masuk.
       */
      baru: out.filter(function (x) {
        if (x.revisi) return false;

        /*
         * Tiga hal yang membunyikan alarm, semuanya lewat satu angka:
         *
         *   - pesanan baru dari Sales
         *   - permintaan barang dari Eksekusi (di layar Gudang)
         *   - barang yang sudah disiapkan Gudang (di layar Eksekusi)
         *
         * Disatukan supaya ketiganya memakai jalur bunyi yang sudah
         * terbukti bekerja, bukan bunyi tersendiri yang ternyata
         * sering tidak terdengar.
         */
        if (x.hanya_sn && x.minta_sn) return true;
        if (x.sn_siap) return true;

        /*
         * Draft membunyikan alarm sampai ada yang mengambilnya.
         *
         * Begitu Tim Eksekusi memilih penanggung jawabnya, pesan
         * itu sudah sampai — dan alarm yang terus berbunyi untuk
         * hal yang sudah dibaca akhirnya diabaikan juga untuk hal
         * yang belum.
         */
        if (x.draft && !x.ditangani) return true;

        if (x.stage_status === 'MENUNGGU_GUDANG') return true;

        // Indent hanya dihitung baru selama belum ditangani
        return x.stage_status === 'MENUNGGU_BARANG' && !x.ditangani;
      }).length,
      proses: out.filter(function (x) { return x.stage_status === 'PROSES_GUDANG' && !x.revisi; }).length,
      revisi: out.filter(function (x) { return !!x.revisi; }).length,
      ganti: (function () {
        try { return hitungGantiTerbuka_(session); } catch (e) { return 0; }
      })(),
      tertahan: out.filter(function (x) { return x.tertahan; }).length,
      stuckMin: batasDiam,
      alarm: {
        ulangDetik: Settings.num('ALARM_REPEAT_SEC', 30),
        tundaMenit: Settings.num('ALARM_SNOOZE_MIN', 5),
        kalimat: Settings.get('ALARM_VOICE_TEXT', 'Ada pesanan baru nih'),
        kalimatRevisi: Settings.get('ALARM_VOICE_REVISI', 'Ada pesanan diubah, mohon dicek ulang'),
        ulangUcapan: Settings.num('ALARM_VOICE_REPEAT', 2),
        pakaiSuara: Util.isTrue(Settings.get('ALARM_VOICE_ON', 'TRUE'))
      },
      pulse: getPulse_(session.role)
    };
  });
}

function apiGudangDone(payload) {
  return withGuard_(payload, { permission: 'TRX_VIEW_STAGE' }, function (session) {
    var semuaCabang = hasPerm_(session, 'TRX_VIEW_ALL');
    var today = Util.todayStr();

    var rows = Repo.columns(DB.SHEET.TRX, [
      'trx_id', 'trx_no', 'branch', 'trx_date', 'cust_name_snap',
      'sales_name', 'stage_status', 'payment_status', 'item_count', 'grand_total',
      'channel', 'gudang_user_id', 'gudang_confirm_at', 'nota_no', 'trx_date',
      'outstanding', 'tempo_jatuh',
      'gudang_petugas_nama', 'eksekusi_pic_nama', 'tech_petugas_nama',
      'kerja_teknisi', 'serah_driver', 'serah_resi', 'metode_serah', 'is_void'
    ]);

    /*
     * Disaring sama seperti antrian.
     *
     * Gudang dan Eksekusi mengerjakan tahapan yang sama, jadi daftar
     * "Sudah Disiapkan" juga harus dipisah — kalau tidak, Eksekusi
     * melihat seluruh pekerjaan Gudang hari itu dan sulit menemukan
     * miliknya sendiri.
     */
    var qD = String(payload.q || '').trim().toUpperCase();
    var berjalanD = String(payload.mode || '') === 'berjalan';
    var peranD = String(session.role);
    var hanyaD = '';
    if (peranD === 'GUDANG') hanyaD = 'RITEL';
    else if (peranD === 'EKSEKUSI') hanyaD = 'ONLINE';

    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var t = rows[i];
      if (Util.isTrue(t.is_void)) continue;

      /*
       * Dua cara melihat daftar yang sama.
       *
       * "Sudah disiapkan" menjawab: apa yang sudah saya kerjakan.
       * "Masih berjalan" menjawab: apa yang belum tuntas — menunggu
       * bayar, menunggu barang datang, belum diserahkan.
       *
       * Yang kedua itu yang dipakai untuk memantau, dan selama ini
       * tidak ada: begitu pesanan lewat dari meja Eksekusi, dia
       * kehilangan pandangan sampai ada yang bertanya.
       */
      if (berjalanD) {
        if (['SELESAI', 'DIBATALKAN'].indexOf(String(t.stage_status)) >= 0) continue;
      } else {
        if (!t.gudang_confirm_at) continue;
      }

      var chD = String(t.channel || 'RITEL').toUpperCase();
      if (hanyaD === 'RITEL' && chD === 'ONLINE') continue;
      if (hanyaD === 'ONLINE' && chD !== 'ONLINE') continue;

      /*
       * Pencarian dan rentang tanggal.
       *
       * Pesanan ditanyakan lagi berhari-hari kemudian — "yang kemarin
       * dikirim ke siapa?". Tanpa ini daftarnya hanya berguna untuk
       * hari itu saja.
       */
      var tglD = Util.dateStr(t.gudang_confirm_at) || Util.dateStr(t.trx_date);
      if (payload.dari && tglD && tglD < String(payload.dari)) continue;
      if (payload.sampai && tglD && tglD > String(payload.sampai)) continue;

      if (qD) {
        var bahanD = [t.trx_no, t.cust_name_snap, t.sales_name, t.nota_no,
                      t.gudang_petugas_nama, t.eksekusi_pic_nama,
                      t.tech_petugas_nama, t.serah_driver]
                       .join(' ').toUpperCase();
        if (bahanD.indexOf(qD) < 0) continue;
      }
      if (!semuaCabang && String(t.branch) !== String(session.branch)) continue;
      if (Util.dateStr(t.trx_date) !== today && !Util.isTrue(payload.semua)) continue;

      out.push({
        trx_id: String(t.trx_id), trx_no: String(t.trx_no),
        cust_name: String(t.cust_name_snap), sales_name: String(t.sales_name || ''),
        stage_status: String(t.stage_status),
        stage_label: stageLabelCh_(t.stage_status, t.channel),
        payment_status: String(t.payment_status),
        item_count: Number(t.item_count) || 0,
        grand_total: Number(t.grand_total) || 0,
        nota_no: String(t.nota_no || ''),
        channel: String(t.channel || 'RITEL'),

        /*
         * Siapa yang memegang di tiap tahap.
         *
         * Pertanyaan yang paling sering datang beberapa hari kemudian
         * bukan "pesanannya apa", tapi "waktu itu siapa yang
         * menyiapkan" dan "dikirim lewat siapa". Tanpa ini jawabannya
         * harus dicari dengan membuka transaksinya satu per satu.
         */
        penyiap: String(t.eksekusi_pic_nama || t.gudang_petugas_nama || ''),
        teknisi: String(t.tech_petugas_nama || ''),
        kerja_teknisi: String(t.kerja_teknisi || ''),
        driver: String(t.serah_driver || ''),
        resi: String(t.serah_resi || ''),
        metode_serah: String(t.metode_serah || ''),

        gudang_confirm_at: Util.isoStr(t.gudang_confirm_at),
        tanggal: Util.dateStr(t.trx_date),
        outstanding: Number(t.outstanding) || 0,
        tempo_jatuh: Util.dateStr(t.tempo_jatuh)
      });
    }
    return out.reverse().slice(0, 150);
  });
}

function apiGudangGetTrx(payload) {
  return withGuard_(payload, { permission: 'ITEM_VIEW' }, function (session) {
    var trx = Repo.findOne(DB.SHEET.TRX, 'trx_id', payload.trx_id);
    if (!trx) throw appErr_('NOT_FOUND', 'Transaksi tidak ditemukan.');
    return buildGudangState_(session, payload.trx_id);
  });
}

// ============================================================
// API — MULAI MENYIAPKAN
// ============================================================

function apiStartPrepare(payload) {
  return withGuard_(payload, { permission: 'ITEM_MARK_PREPARED', lock: 'ringan' }, function (session) {
    var trx = loadTrxForGudang_(session, payload.trx_id);

    /*
     * Kabar "barang sudah disiapkan Gudang" ditandai sudah dibaca.
     *
     * Tanpa penanda ini alarmnya terus berbunyi setiap kali antrian
     * dibaca ulang, walau orangnya sudah membuka pesanannya — dan
     * alarm yang berbunyi terus justru mulai diabaikan.
     */
    try {
      var daftarMs = bacaMintaSn_(trx), adaUbah = false;
      daftarMs.forEach(function (m) {
        if (String(m.status) === 'SELESAI' && !m.dilihat) { m.dilihat = true; adaUbah = true; }
      });
      if (adaUbah) tulisMintaSn_(trx, daftarMs);
    } catch (eD) {}

    // Begitu Gudang membuka pesanannya, penanda revisi dianggap sudah dilihat
    var flags = {};
    try { flags = JSON.parse(String(trx.override_flags || '') || '{}'); } catch (e) {}
    if (flags.revisi && !flags.revisi.dibaca) {
      flags.revisi.dibaca = true;
      flags.revisi.dibaca_oleh = session.full_name;
      flags.revisi.dibaca_at = nowIso_();
      Repo.update(DB.SHEET.TRX, trx._row, { override_flags: JSON.stringify(flags) });
      trx.override_flags = JSON.stringify(flags);
      bumpPulse_('GUDANG');
    }

    if (String(trx.stage_status) === 'PROSES_GUDANG') {
      return buildGudangState_(session, trx.trx_id);
    }

    bumpRevision_(session, trx, {
      stage_status: 'PROSES_GUDANG',
      gudang_user_id: session.user_id
    });

    logAudit_(session, {
      entity: 'TRX', entity_id: trx.trx_id, trx_no: trx.trx_no,
      action: 'STAGE_CHANGE', field: 'stage_status',
      old_value: 'MENUNGGU_GUDANG', new_value: 'PROSES_GUDANG'
    });
    logTimeline_(session, {
      trx_id: trx.trx_id, trx_no: trx.trx_no,
      event_code: 'GUDANG_START', stage_after: 'PROSES_GUDANG',
      event_label: 'Gudang ' + session.full_name + ' mulai menyiapkan barang',
      detail: ''
    });

    return buildGudangState_(session, trx.trx_id);
  });
}

// ============================================================
// PENYIMPANAN SERIAL NUMBER
// ============================================================

/**
 * Menyimpan SN satu barang. Dipakai di dalam proses konfirmasi,
 * bukan dipanggil sendiri-sendiri dari browser.
 *
 * semuaSn = daftar seluruh baris SN yang sudah dibaca sekali di awal,
 * supaya tidak membaca sheet berulang untuk tiap barang.
 */
/**
 * Menyimpan serial number untuk SELURUH barang sekaligus.
 *
 * Sebelumnya dikerjakan per barang, dan tiap barang membaca ulang
 * seluruh sheet SN dua kali — sekali untuk melihat isi lama, sekali
 * lagi untuk menghitung hasilnya. Pesanan lima barang berarti sepuluh
 * pembacaan penuh, dan itu menghabiskan 70% waktu konfirmasi Gudang.
 *
 * Sekarang sheet SN dibaca sekali di awal, seluruh perubahan dihitung
 * di memori, lalu ditulis sekali di akhir. Hasil akhirnya dihitung
 * dari data yang sudah ada, bukan dibaca ulang.
 */
function simpanSnBorongan_(session, trx, items, snMasuk, now) {
  // Satu pembacaan untuk semuanya
  var semua = Repo.findManyFast(DB.SHEET.SN, 'trx_id', trx.trx_id);

  var aktifPerItem = {};      // item_id -> { seq -> baris }
  semua.forEach(function (r) {
    if (!Util.isTrue(r.is_active)) return;
    var k = String(r.item_id);
    if (!aktifPerItem[k]) aktifPerItem[k] = {};
    aktifPerItem[k][Number(r.unit_seq)] = r;
  });

  var barisNonaktif = [];     // nomor baris SN lama yang diganti
  var tambah = [];            // SN baru
  var ringkasPerItem = {};    // item_id -> daftar SN yang berlaku
  var totalTerisi = 0;

  items.forEach(function (it) {
    var kunci = String(it.item_id);
    var qty = Number(it.qty) || 0;
    var masuk = snMasuk[kunci];
    var lamaSeq = aktifPerItem[kunci] || {};

    // Barang yang tidak dikirim isiannya: yang lama tetap berlaku
    if (!masuk) {
      var tetap = [];
      Object.keys(lamaSeq).forEach(function (u) { tetap.push(lamaSeq[u]); });
      tetap.sort(function (a, b) { return Number(a.unit_seq) - Number(b.unit_seq); });
      ringkasPerItem[kunci] = tetap.map(function (r) { return String(r.serial_number); });
      totalTerisi += tetap.length;
      return;
    }

    var berlaku = [];

    for (var u = 1; u <= qty; u++) {
      var baru = String(masuk[u - 1] || '').trim().toUpperCase();
      var row = lamaSeq[u];
      var sebelum = row ? String(row.serial_number).trim().toUpperCase() : '';

      if (baru === sebelum) {
        if (baru) berlaku.push(baru);
        continue;
      }

      // SN lama tidak dihapus, hanya dinonaktifkan
      if (row) barisNonaktif.push(row._row);

      if (baru) {
        berlaku.push(baru);
        tambah.push({
          sn_id: Util.id('SN'), trx_id: trx.trx_id, trx_no: trx.trx_no,
          item_id: it.item_id, product_code: it.product_code,
          unit_seq: u, serial_number: baru,
          input_by: session.user_id, input_at: now,
          is_active: true, replaced_reason: ''
        });
      }

      logAudit_(session, {
        entity: 'SN', entity_id: it.item_id, trx_no: trx.trx_no,
        action: sebelum ? 'UPDATE' : 'CREATE', field: 'sn_unit_' + u,
        old_value: sebelum || '(kosong)', new_value: baru || '(kosong)'
      });
    }

    ringkasPerItem[kunci] = berlaku;
    totalTerisi += berlaku.length;
  });

  // Tiga penulisan untuk seluruh pesanan, bukan sepuluh per barang
  if (barisNonaktif.length) {
    Repo.setKolom(DB.SHEET.SN, barisNonaktif, 'is_active', false);
    Repo.setKolom(DB.SHEET.SN, barisNonaktif, 'replaced_reason',
      'Diganti saat konfirmasi ' + Util.dateStr(now));
  }
  if (tambah.length) Repo.appendMany(DB.SHEET.SN, tambah);

  /*
   * Ringkasan seluruh barang ditulis per kolom, bukan per barang.
   *
   * Barang satu pesanan menempati baris berurutan, jadi satu kolom
   * untuk lima barang cukup satu perintah. Sebelumnya tiap barang
   * ditulis sendiri-sendiri — lima barang berarti sepuluh perjalanan
   * ke spreadsheet hanya untuk dua kolom.
   */
  var isiQty = [], isiRingkas = [], isiSiap = [], isiOleh = [], isiJam = [];

  items.forEach(function (it) {
    var berlaku = ringkasPerItem[String(it.item_id)];
    if (!berlaku) return;

    isiQty.push([it._row, berlaku.length]);
    isiRingkas.push([it._row, berlaku.join(', ')]);

    if (!Util.isTrue(it.prepared)) {
      isiSiap.push([it._row, true]);
      isiOleh.push([it._row, session.full_name]);
      isiJam.push([it._row, now]);
    }
  });

  Repo.setKolomNilai(DB.SHEET.ITEMS, isiQty, 'sn_filled_qty');
  Repo.setKolomNilai(DB.SHEET.ITEMS, isiRingkas, 'sn_summary');
  Repo.setKolomNilai(DB.SHEET.ITEMS, isiSiap, 'prepared');
  Repo.setKolomNilai(DB.SHEET.ITEMS, isiOleh, 'prepared_by');
  Repo.setKolomNilai(DB.SHEET.ITEMS, isiJam, 'prepared_at');

  return { terisi: totalTerisi };
}

/**
 * Memeriksa seluruh SN yang dikirim sebelum satu pun ditulis.
 * Kalau ada yang bermasalah, tidak ada yang tersimpan sama sekali —
 * jadi tidak pernah ada kondisi setengah jadi.
 */
function periksaSn_(trx, items, snMasuk) {
  var masalah = [];
  var terlihat = {};

  // Kembar di dalam satu pesanan
  items.forEach(function (it) {
    var daftar = snMasuk[String(it.item_id)] || [];
    for (var u = 0; u < daftar.length; u++) {
      var sn = String(daftar[u] || '').trim().toUpperCase();
      if (!sn) continue;
      if (terlihat[sn]) {
        masalah.push({
          sn: sn, item_id: String(it.item_id), seq: u,
          pesan: 'SN "' + sn + '" diisi lebih dari sekali — pada ' +
            String(it.product_name) + ' unit ' + (u + 1) + '. ' +
            'Setiap unit punya serial number sendiri. Kalau barang ini memang tidak ' +
            'punya SN, kosongkan saja kotaknya.'
        });
      }
      terlihat[sn] = true;
    }
  });

  // Sudah dipakai transaksi lain
  var semuaSn = Repo.columns(DB.SHEET.SN,
    ['sn_id', 'trx_id', 'trx_no', 'item_id', 'serial_number', 'is_active']);

  var pakai = {};
  for (var c = 0; c < semuaSn.length; c++) {
    var row = semuaSn[c];
    if (!Util.isTrue(row.is_active)) continue;
    if (String(row.trx_id) === String(trx.trx_id)) continue;
    pakai[String(row.serial_number).trim().toUpperCase()] = String(row.trx_no);
  }

  items.forEach(function (it) {
    var daftar = snMasuk[String(it.item_id)] || [];
    for (var u = 0; u < daftar.length; u++) {
      var sn2 = String(daftar[u] || '').trim().toUpperCase();
      if (!sn2) continue;
      if (pakai[sn2]) {
        masalah.push({
          sn: sn2, item_id: String(it.item_id), seq: u,
          pesan: 'SN "' + sn2 + '" sudah dipakai di transaksi ' + pakai[sn2] + '.'
        });
      }
    }
  });

  return masalah;
}

/** Tetap disediakan untuk keperluan koreksi, tidak dipakai layar Gudang */
function apiSaveItemSn(payload) {
  return withGuard_(payload, { permission: 'SN_INPUT', lock: true }, function (session) {
    var trx = loadTrxForGudang_(session, payload.trx_id, payload.revision);
    var it = Repo.findOne(DB.SHEET.ITEMS, 'item_id', payload.item_id);
    if (!it || String(it.trx_id) !== String(trx.trx_id)) {
      throw appErr_('NOT_FOUND', 'Barang tidak ditemukan di pesanan ini.');
    }

    var snMasuk = {};
    snMasuk[String(it.item_id)] = payload.sns || [];
    var masalah = periksaSn_(trx, [it], snMasuk);
    if (masalah.length) throw appErr_('SN_USED', masalah[0].pesan);

    var masukSatu = {};
    masukSatu[String(it.item_id)] = payload.sns || [];
    simpanSnBorongan_(session, trx, [it], masukSatu, nowIso_());
    bumpRevision_(session, trx);
    return buildGudangState_(session, trx.trx_id);
  });
}

// ============================================================
// API — KONFIRMASI BARANG SIAP
// ============================================================

/**
 * Satu panggilan untuk seluruh pesanan:
 * periksa SN → simpan SN → tandai barang siap → teruskan ke Admin.
 *
 * payload.sn = { item_id: ['SN1','SN2', ...], ... }
 */
function apiConfirmWarehouse(payload) {
  return withGuard_(payload, { permission: 'TRX_CONFIRM_GUDANG', lock: 'ringan' }, function (session) {
    var jam = Jam.mulai('apiConfirmWarehouse');
    var trx = loadTrxForGudang_(session, payload.trx_id, payload.revision);

    var items = Repo.findManyFast(DB.SHEET.ITEMS, 'trx_id', trx.trx_id)
                    .filter(function (i) { return Util.isTrue(i.is_active); });

    if (!items.length) {
      throw appErr_('NO_ITEM', 'Pesanan ini tidak punya barang. Hubungi Sales.');
    }

    var snMasuk = payload.sn || {};

    /*
     * 1. Periksa SN yang diisi. Kalau ada yang bentrok, tidak ada yang ditulis.
     *
     * Bagian ini diantre sebentar, karena di sinilah dua petugas bisa
     * benar-benar bentrok: memasukkan serial number yang sama untuk dua
     * transaksi berbeda. Sisanya tidak perlu diantre.
     */
    jam.tandai('baca transaksi & barang');

    var masalah = denganKunci_(function () {
      return periksaSn_(trx, items, snMasuk);
    }, 15000);

    jam.tandai('periksa SN');
    if (masalah.length) {
      var e = appErr_('SN_USED', masalah[0].pesan +
        (masalah.length > 1 ? ' (dan ' + (masalah.length - 1) + ' SN lain bermasalah)' : ''));
      e.details = masalah;
      throw e;
    }

    // 2. Barang yang biasanya punya SN tapi dikosongkan — diperingatkan,
    //    tidak diblokir. Penandanya hasil tebakan sistem, jadi tidak boleh
    //    menghambat kerja kalau tebakannya meleset.
    var kosong = [];
    items.forEach(function (i) {
      var saran = saranSn_(i.product_code, i.product_name,
                           i.need_sn === '' ? undefined : i.need_sn);
      if (!saran.perlu) return;

      var qty = Number(i.qty) || 0;
      var daftar = snMasuk[String(i.item_id)];

      var terisi;
      if (daftar) {
        terisi = 0;
        for (var u = 0; u < qty; u++) if (String(daftar[u] || '').trim()) terisi++;
      } else {
        terisi = Number(i.sn_filled_qty) || 0;
      }

      if (terisi < qty) {
        kosong.push({
          item_id: String(i.item_id), product_name: String(i.product_name),
          terisi: terisi, qty: qty, alasan: saran.alasan
        });
      }
    });

    if (kosong.length && !Util.isTrue(payload.abaikan_sn)) {
      var e2 = appErr_('SN_WARNING',
        kosong.length + ' barang biasanya punya Serial Number tapi dikosongkan.');
      e2.details = kosong;
      throw e2;
    }

    // 3. Baru menulis — seluruh barang sekaligus, bukan satu per satu
    var now = nowIso_();
    var totalSn = simpanSnBorongan_(session, trx, items, snMasuk, now).terisi;

    // Siapa yang menyiapkan barangnya.
    //
    // Daftar petugas dibaca ulang tanpa memakai salinan, supaya tidak
    // terjadi lagi kejadian layar dan server melihat daftar yang berbeda.
    bustGudangCache_();
    var petugas = cariPetugasGudang_(payload.petugas);
    if (!petugas && Util.isTrue(Settings.get('GUDANG_PETUGAS_WAJIB', 'TRUE'))) {
      var adaDaftar = false;
      try { adaDaftar = daftarGudangIndex_().filter(function (p) { return p.a; }).length > 0; }
      catch (e) {}
      if (adaDaftar) {
        // Keterangan dibuat jelas: kalau kodenya sebenarnya terkirim tapi
        // tidak dikenali, masalahnya beda dengan kalau memang tidak dipilih.
        var diterima = String(payload.petugas || '').trim();
        throw appErr_('NO_PETUGAS', diterima
          ? 'Nama petugas "' + diterima + '" tidak dikenali. Kemungkinan kodenya sudah ' +
            'dinonaktifkan. Pilih ulang namanya.'
          : 'Pilih dulu nama petugas yang menyiapkan barang ini.');
      }
    }

    // Dilanjutkan tanpa SN padahal ditandai — dicatat supaya bisa
    // ditelusuri kalau suatu saat ada klaim garansi
    if (kosong.length) {
      kosong.forEach(function (k) {
        logAudit_(session, {
          entity: 'ITEM', entity_id: k.item_id, trx_no: trx.trx_no,
          action: 'OVERRIDE', field: 'sn_dikosongkan',
          old_value: k.alasan, new_value: 'dilanjutkan tanpa SN (' + k.terisi + '/' + k.qty + ')',
          reason: String(payload.alasan_sn || 'Gudang menyatakan barang ini tanpa SN')
        });
      });
    }

    /*
     * Selalu ke Admin dulu.
     *
     * Termasuk pesanan indent: nota pesanannya memang sudah ada, tapi
     * nota penjualan (JL-PWT) baru diterbitkan sekarang, setelah
     * barangnya benar-benar ada di tangan.
     */
    /*
     * Jalur pintas ke Teknisi, sebelum nota dan pembayaran.
     *
     * Ada customer yang minta unitnya dirakit atau diaktivasi dulu,
     * lalu datang membayar belakangan — kadang bukan di hari yang
     * sama. Memaksa nota terbit lebih dulu berarti Admin menerbitkan
     * nota untuk barang yang belum tentu jadi diambil.
     *
     * Jadi boleh langsung ke Teknisi, dengan satu syarat: setelah
     * Teknisi selesai, pesanannya KEMBALI ke Admin untuk nota lalu
     * ke Kasir. Barang tetap tidak bisa keluar tanpa melewati
     * keduanya.
     */
    var keTeknisiDulu = Util.isTrue(payload.ke_teknisi);
    var tahapSetelah = keTeknisiDulu ? 'MENUNGGU_AKTIVASI' : 'SIAP_NOTA';

    jam.tandai('simpan SN');

    /*
     * Perlu Teknisi atau tidak, ditentukan yang menyiapkan.
     *
     * Dia yang memegang barangnya dan tahu isinya apa. Laptop perlu
     * aktivasi; mouse, tas, dan tinta tidak. Memaksa semuanya lewat
     * Teknisi membuat antrian di sana penuh barang yang cuma lewat.
     *
     * Hanya berlaku untuk pesanan online. Ritel NB selalu perlu,
     * seperti yang berjalan selama ini.
     */
    /*
     * Apa yang diminta dikerjakan Teknisi.
     *
     * Bukan sekadar "perlu atau tidak" — Teknisi perlu tahu apa yang
     * harus dikerjakan. Aktivasi, rakit, inkcharging, cek unit: tiga
     * pekerjaan berbeda dengan alat dan waktu yang berbeda pula.
     *
     * Daftar kosong berarti tidak perlu lewat Teknisi sama sekali.
     */
    var kerjaTek = '';
    if (String(trx.channel || '').toUpperCase() === 'ONLINE' &&
        payload.kerja_teknisi !== undefined) {
      kerjaTek = String(payload.kerja_teknisi || '').substring(0, 200);
    }

    var patchTahap = { stage_status: tahapSetelah };
    if (String(trx.channel || '').toUpperCase() === 'ONLINE') {
      patchTahap.perlu_teknisi = !!kerjaTek;
    }

    bumpRevision_(session, trx, {
      stage_status: tahapSetelah,
      perlu_teknisi: keTeknisiDulu ? true : patchTahap.perlu_teknisi,
      kerja_teknisi: kerjaTek,

      /*
       * Pesan untuk Teknisi, misalnya "dikerjakan setelah user
       * datang". Tanpa ini Teknisi mengerjakan begitu masuk antrian,
       * padahal kadang justru harus ditunda.
       */
      catatan_teknisi: String(payload.catatan_teknisi || '').substring(0, 200),

      tek_dulu: keTeknisiDulu,
      gudang_user_id: session.user_id,
      gudang_confirm_at: now,
      gudang_petugas: petugas ? petugas.code : '',
      gudang_petugas_nama: petugas ? petugas.name : ''
    });

    var totalQty = items.reduce(function (n, i) { return n + (Number(i.qty) || 0); }, 0);
    if (totalSn) bustSnHistCache_();   // supaya pembelajaran SN ikut terbarui

    logAudit_(session, {
      entity: 'TRX', entity_id: trx.trx_id, trx_no: trx.trx_no,
      action: 'STAGE_CHANGE', field: 'stage_status',
      old_value: String(trx.stage_status), new_value: 'SIAP_NOTA'
    });
    logTimeline_(session, {
      trx_id: trx.trx_id, trx_no: trx.trx_no,
      event_code: 'GUDANG_CONFIRM', stage_after: tahapSetelah,
      event_label: 'Gudang konfirmasi barang siap' +
        (petugas ? ' · disiapkan oleh ' + petugas.name : '') +
        ' · diinput ' + session.full_name,
      detail: items.length + ' item · ' + totalQty + ' unit' + (totalSn ? ' · ' + totalSn + ' SN' : '')
    });

    pushNotif_({
      target_role: 'ADMIN', target_branch: trx.branch,
      trx_id: trx.trx_id, trx_no: trx.trx_no,
      type: 'ORDER_READY', priority: 'NORMAL',
      title: 'Siap dibuat nota',
      body: trx.trx_no + ' · ' + trx.cust_name_snap + ' · ' + items.length + ' item'
    });

    pushNotif_({
      target_role: 'SALES', target_branch: trx.branch,
      trx_id: trx.trx_id, trx_no: trx.trx_no,
      type: 'ORDER_READY', priority: 'NORMAL',
      title: 'Barang sudah disiapkan',
      body: trx.trx_no + ' · ' + trx.cust_name_snap
    });

    jam.tandai('ubah tahap & catat');
    jam.selesai();

    return { trx_no: String(trx.trx_no), stage: tahapSetelah, sn_tersimpan: totalSn };
  });
}

// ============================================================
// API — RIWAYAT BARANG KELUAR
// ============================================================

function apiItemHistory(payload) {
  return withGuard_(payload, { permission: 'ITEM_VIEW' }, function (session) {
    var q = String(payload.q || '').trim().toUpperCase();
    var hari = Number(payload.hari || 30);
    var semuaCabang = hasPerm_(session, 'TRX_VIEW_ALL');

    var batas = new Date();
    batas.setDate(batas.getDate() - hari);
    var batasMs = batas.getTime();

    var trxRows = Repo.columns(DB.SHEET.TRX, [
      'trx_id', 'trx_no', 'branch', 'trx_date', 'cust_name_snap', 'cust_phone_snap',
      'sales_name', 'sales_code', 'stage_status', 'payment_status',
      'gudang_confirm_at', 'nota_no', 'channel', 'override_flags', 'is_void'
    ]);

    var peranL = String(session.role);
    var hanyaL = '';
    if (peranL === 'GUDANG') hanyaL = 'RITEL';
    else if (peranL === 'EKSEKUSI') hanyaL = 'ONLINE';

    var peta = {};
    for (var i = 0; i < trxRows.length; i++) {
      var t = trxRows[i];
      if (Util.isTrue(t.is_void)) continue;
      if (!t.gudang_confirm_at) continue;
      if (!semuaCabang && String(t.branch) !== String(session.branch)) continue;
      if (hari > 0) {
        var waktu = new Date(Util.isoStr(t.gudang_confirm_at)).getTime();
        if (waktu < batasMs) continue;
      }
      peta[String(t.trx_id)] = {
        trx_no: String(t.trx_no),
        cust_name: String(t.cust_name_snap),
        cust_phone: Util.hp(t.cust_phone_snap),
        sales_name: String(t.sales_name || ''),
        sales_code: String(t.sales_code || ''),
        channel: String(t.channel || 'RITEL'),
        sumber: String(t.sumber || ''),
        metode_serah: String(t.metode_serah || ''),
        stage_status: String(t.stage_status),
        stage_label: stageLabel_(t.stage_status),
        payment_status: String(t.payment_status),
        nota_no: String(t.nota_no || ''),
        keluar_at: Util.isoStr(t.gudang_confirm_at)
      };
    }

    /*
     * Serial number yang sudah dinonaktifkan ikut ditampilkan.
     *
     * Unit yang ditarik kembali — karena rusak, salah tembak, atau
     * diganti — SN-nya dinonaktifkan supaya bisa dijual lagi. Untuk
     * stok itu benar, tapi jejaknya jadi hilang: dicari di Lacak Barang
     * Keluar tidak ketemu, seolah unit itu tidak pernah menyentuh
     * transaksi mana pun.
     *
     * Admin stok justru perlu melihat itu — untuk tahu unit ini pernah
     * keluar lalu kembali, bukan barang yang tidak pernah bergerak.
     */
    var snPerItem = {};
    Repo.columns(DB.SHEET.SN,
      ['sn_id', 'item_id', 'serial_number', 'unit_seq', 'is_active', 'replaced_reason'])
      .forEach(function (s) {
        var k = String(s.item_id);
        if (!snPerItem[k]) snPerItem[k] = [];
        snPerItem[k].push({
          seq: Number(s.unit_seq),
          sn: String(s.serial_number),
          aktif: Util.isTrue(s.is_active),
          alasan: String(s.replaced_reason || '')
        });
      });

    var itemRows = Repo.columns(DB.SHEET.ITEMS, [
      'item_id', 'trx_id', 'product_code', 'product_name', 'source',
      'qty', 'item_note', 'prepared_by', 'is_active'
    ]);

    var out = [];
    for (var j = 0; j < itemRows.length; j++) {
      var it = itemRows[j];
      if (!Util.isTrue(it.is_active)) continue;

      var info = peta[String(it.trx_id)];
      if (!info) continue;

      var semuaSn = (snPerItem[String(it.item_id)] || [])
        .sort(function (a, b) {
          if (a.aktif !== b.aktif) return a.aktif ? -1 : 1;
          return a.seq - b.seq;
        });

      var sns = semuaSn.filter(function (s) { return s.aktif; })
                       .map(function (s) { return s.sn; });
      var snDitarik = semuaSn.filter(function (s) { return !s.aktif; });

      if (q) {
        var bahan = [
          String(it.product_code), String(it.product_name),
          info.trx_no, info.cust_name, info.sales_name,
          info.sales_code, info.nota_no,
          sns.join(' '),
          snDitarik.map(function (s) { return s.sn; }).join(' ')
        ].join(' ').toUpperCase();
        if (bahan.indexOf(q) < 0) continue;
      }

      out.push({
        item_id: String(it.item_id),
        product_code: String(it.product_code),
        product_name: String(it.product_name),
        source: String(it.source),
        qty: Number(it.qty) || 0,
        item_note: String(it.item_note || ''),
        prepared_by: String(it.prepared_by || ''),
        /*
         * Kejadian ganti unit ikut dikirim.
         *
         * Sebelumnya yang terlihat cuma "keluar dari gudang" — padahal
         * unit yang ditarik karena rusak lalu diganti punya cerita
         * yang justru paling perlu ditelusuri: kapan diminta, apa
         * keluhannya, SN lamanya apa, penggantinya apa.
         */
        ganti: (function () {
          var f = {};
          try { f = JSON.parse(String(info.override_flags || '') || '{}'); } catch (e) { return []; }
          if (!f.ganti || !f.ganti.length) return [];

          return f.ganti
            .filter(function (g) { return String(g.item_id) === String(it.item_id); })
            .map(function (g) {
              return {
                unit: g.unit_seq,
                status: String(g.status),
                keluhan: String(g.keluhan || ''),
                sn_lama: String(g.sn_rusak || ''),
                sn_baru: String(g.sn_baru || ''),
                nota_ganti: String(g.nota_ganti || ''),
                minta_at: String(g.minta_at || ''),
                minta_by: String(g.minta_by || ''),
                selesai_at: String(g.selesai_at || '')
              };
            });
        })(),
        sns: sns,
        sns_ditarik: snDitarik.map(function (s) {
          return { sn: s.sn, unit: s.seq, alasan: s.alasan };
        }),
        trx_no: info.trx_no, cust_name: info.cust_name, cust_phone: info.cust_phone,
        sales_name: info.sales_name, sales_code: info.sales_code,
        nota_no: info.nota_no,
        stage_status: info.stage_status, stage_label: info.stage_label,
        payment_status: info.payment_status,
        keluar_at: info.keluar_at
      });
    }

    out.sort(function (a, b) {
      return a.keluar_at < b.keluar_at ? 1 : (a.keluar_at > b.keluar_at ? -1 : 0);
    });

    return {
      list: out.slice(0, 200),
      total: out.length,
      totalUnit: out.reduce(function (n, r) { return n + r.qty; }, 0),
      dipotong: out.length > 200
    };
  });
}

// ============================================================
// PULSE
// ============================================================

// Catatan: apiPulse sekarang ada di 12_NotifyService, dipakai bersama
// seluruh divisi. Versi lama yang khusus Gudang dibuang dari sini supaya
// tidak ada dua fungsi bernama sama — yang satu diam-diam menimpa yang lain.

// ============================================================
// PENGATURAN ALARM — jalankan sekali dari editor
// ============================================================

function siapkanPengaturanGudang() {
  var sh = Repo.sheet(DB.SHEET.SETTINGS);
  var ada = {};
  Repo.columns(DB.SHEET.SETTINGS, ['key']).forEach(function (r) { ada[String(r.key).trim()] = true; });

  var now = nowIso_();
  var baru = [
    ['ALARM_REPEAT_SEC', '30', 'NUMBER', 'GUDANG',
     'Jeda bunyi alarm diulang selama masih ada pesanan yang belum dibuka Gudang (detik). Isi 0 untuk mematikan pengulangan.'],
    ['ALARM_SNOOZE_MIN', '5', 'NUMBER', 'GUDANG',
     'Lama alarm ditunda saat tombol Tunda ditekan (menit).'],
    ['ALARM_VOICE_ON', 'TRUE', 'TEXT', 'GUDANG',
     'TRUE = alarm juga membacakan kalimat, bukan cuma nada.'],
    ['ALARM_VOICE_TEXT', 'Ada pesanan baru nih', 'TEXT', 'GUDANG',
     'Kalimat yang dibacakan saat ada pesanan baru. Dibacakan setelah bunyi ting-tong dua kali.'],
    ['ALARM_VOICE_REPEAT', '2', 'NUMBER', 'GUDANG',
     'Berapa kali kalimatnya diulang setiap alarm berbunyi.'],
    ['ALARM_VOICE_REVISI', 'Ada pesanan diubah, mohon dicek ulang', 'TEXT', 'GUDANG',
     'Kalimat yang dibacakan saat ada pesanan yang diubah Sales.']
  ].filter(function (s) { return !ada[s[0]]; });

  if (baru.length) {
    sh.getRange(sh.getLastRow() + 1, 1, baru.length, 7).setValues(
      baru.map(function (s) { return [s[0], s[1], s[2], s[3], s[4], now, 'SETUP']; }));
  }
  Settings.bust();

  return kabar_(baru.length + ' pengaturan alarm gudang ditambahkan.\n\n' +
    'Bisa diubah kapan saja di sheet SETTINGS:\n' +
    '• ALARM_REPEAT_SEC — jeda pengulangan bunyi\n' +
    '• ALARM_SNOOZE_MIN — lama tombol tunda\n' +
    '• ALARM_VOICE_TEXT — kalimat yang dibacakan');
}

// ============================================================
// KELOLA SERIAL NUMBER
//
// Salah tembak SN terjadi cukup sering, dan akibatnya baru terasa
// berhari-hari kemudian saat barangnya benar-benar terjual — SN-nya
// ditolak karena dianggap sudah keluar.
//
// Membetulkannya lewat sheet langsung berisiko: salah hapus satu
// baris di sheet lain akibatnya jauh lebih besar. Jadi disediakan
// layarnya sendiri.
// ============================================================

function apiCariSn(payload) {
  return withGuard_(payload, { permission: 'SN_VIEW' }, function (session) {
    var q = String(payload.q || '').trim().toUpperCase();
    if (q.length < 3) {
      throw appErr_('TOO_SHORT', 'Ketik minimal 3 huruf atau angka dari serial numbernya.');
    }

    var semuaCabang = hasPerm_(session, 'TRX_VIEW_ALL');

    var rows = Repo.columns(DB.SHEET.SN, [
      'sn_id', 'trx_id', 'trx_no', 'item_id', 'product_code',
      'serial_number', 'unit_seq', 'input_at', 'input_by',
      'is_active', 'replaced_reason'
    ]);

    // Nama customer diambil sekali untuk semua, bukan per baris
    var trxInfo = {};
    Repo.columns(DB.SHEET.TRX, ['trx_id', 'trx_no', 'branch', 'cust_name_snap',
                                 'stage_status', 'trx_date', 'is_void'])
      .forEach(function (t) {
        trxInfo[String(t.trx_id)] = t;
      });

    var out = [];
    rows.forEach(function (r) {
      var sn = String(r.serial_number || '').toUpperCase();
      var kode = String(r.product_code || '').toUpperCase();
      if (sn.indexOf(q) < 0 && kode.indexOf(q) < 0) return;

      var t = trxInfo[String(r.trx_id)] || {};
      if (!semuaCabang && t.branch && String(t.branch) !== String(session.branch)) return;

      out.push({
        sn_id: String(r.sn_id),
        serial_number: String(r.serial_number),
        product_code: String(r.product_code || ''),
        unit_seq: Number(r.unit_seq) || 1,
        trx_no: String(r.trx_no || t.trx_no || ''),
        trx_id: String(r.trx_id),
        cust_name: String(t.cust_name_snap || ''),
        trx_date: Util.dateStr(t.trx_date),
        stage_label: t.stage_status ? stageLabel_(t.stage_status) : '',
        dibatalkan: Util.isTrue(t.is_void),
        aktif: Util.isTrue(r.is_active),
        alasan: String(r.replaced_reason || ''),
        input_at: Util.isoStr(r.input_at)
      });
    });

    out.sort(function (a, b) {
      if (a.aktif !== b.aktif) return a.aktif ? -1 : 1;
      return a.input_at < b.input_at ? 1 : -1;
    });

    return {
      list: out.slice(0, 50), total: out.length,
      bisaHapus: hasPerm_(session, 'TRX_EDIT_ALL')
    };
  });
}

/**
 * Membebaskan atau menghapus serial number.
 *
 * mode 'bebas'  — dinonaktifkan. SN langsung bisa dipakai lagi, tapi
 *                 barisnya tetap ada beserta alasannya. Ini yang
 *                 dipakai untuk salah tembak biasa.
 *
 * mode 'hapus'  — barisnya dihapus sepenuhnya. Hanya untuk isian yang
 *                 memang tidak pernah ada barangnya, misalnya angka
 *                 asal seperti "10". Butuh izin Admin ke atas.
 */
function apiBebaskanSn(payload) {
  return withGuard_(payload, { permission: 'SN_INPUT', lock: 'ringan' }, function (session) {
    var daftar = payload.sn_ids || [];
    if (!daftar.length) throw appErr_('EMPTY', 'Belum ada serial number yang dipilih.');

    var alasan = String(payload.alasan || '').trim();
    if (alasan.length < 4) {
      throw appErr_('NO_REASON',
        'Isi alasannya dulu. Ini yang dibaca kalau suatu saat ditelusuri.');
    }

    var hapus = String(payload.mode) === 'hapus';
    if (hapus && !hasPerm_(session, 'TRX_EDIT_ALL')) {
      throw appErr_('FORBIDDEN',
        'Menghapus permanen hanya bisa oleh Admin atau Super Admin. ' +
        'Pakai "Bebaskan" — SN-nya tetap langsung bisa dipakai lagi.');
    }

    var pilih = {};
    daftar.forEach(function (x) { pilih[String(x)] = true; });

    var semua = Repo.all(DB.SHEET.SN);

    var kena = [], baris = [];
    semua.forEach(function (r) {
      if (!pilih[String(r.sn_id)]) return;
      kena.push({ sn: String(r.serial_number), trx_no: String(r.trx_no || ''), row: r._row });
      baris.push(r._row);
    });

    if (!kena.length) throw appErr_('NOT_FOUND', 'Serial number tidak ditemukan.');

    if (hapus) {
      baris.sort(function (a, b) { return b - a; });
      var sh = Repo.sheet(DB.SHEET.SN);
      baris.forEach(function (b) { sh.deleteRow(b); });
      Repo.bustSheet(DB.SHEET.SN);
    } else {
      Repo.setKolom(DB.SHEET.SN, baris, 'is_active', false);
      Repo.setKolom(DB.SHEET.SN, baris, 'replaced_reason',
        alasan + ' — dibebaskan ' + session.full_name);
    }

    kena.forEach(function (k) {
      logAudit_(session, {
        entity: 'SN', entity_id: k.sn, trx_no: k.trx_no,
        action: hapus ? 'DELETE' : 'VOID',
        old_value: k.sn + ' aktif', new_value: hapus ? '(dihapus)' : '(dibebaskan)',
        reason: alasan
      });
    });

    bustSnHistCache_();
    flushLog_();

    return {
      jumlah: kena.length,
      mode: hapus ? 'hapus' : 'bebas',
      daftar: kena.map(function (k) { return k.sn; })
    };
  });
}

/**
 * Membuka pesanan untuk DILIHAT saja, apa pun tahapnya.
 *
 * Pesanan yang sudah lewat Gudang tetap sering ditanyakan — SN-nya
 * apa, siapa yang menyiapkan, barangnya berapa. Selama ini membukanya
 * ditolak karena tahapnya sudah bukan di Gudang lagi, padahal yang
 * diminta cuma melihat.
 *
 * Yang dibatasi tetap tindakannya: mengisi SN dan mengonfirmasi hanya
 * bisa pada tahap yang semestinya. Melihat tidak merusak apa pun.
 */
function apiLihatPesanan(payload) {
  return withGuard_(payload, {}, function (session) {
    if (!hasPerm_(session, 'TRX_VIEW_STAGE') && !hasPerm_(session, 'TRX_VIEW_OWN')) {
      throw appErr_('FORBIDDEN', 'Anda tidak punya akses ke pesanan ini.');
    }
    var trx = Repo.findOne(DB.SHEET.TRX, 'trx_id', payload.trx_id);
    if (!trx) throw appErr_('NOT_FOUND', 'Transaksi tidak ditemukan.');

    if (String(trx.branch) !== String(session.branch) &&
        !hasPerm_(session, 'TRX_VIEW_ALL')) {
      throw appErr_('OTHER_BRANCH', 'Pesanan ini milik cabang lain.');
    }

    var state = buildGudangState_(session, payload.trx_id);

    /*
     * Penanda bahwa layarnya hanya untuk dilihat.
     *
     * Tombol-tombolnya disembunyikan di layar, bukan dibiarkan ada
     * lalu ditolak saat ditekan — menekan tombol yang ternyata tidak
     * berlaku lebih membingungkan daripada tidak ada tombolnya.
     */
    state.header.baca_saja =
      ['MENUNGGU_GUDANG', 'PROSES_GUDANG'].indexOf(String(trx.stage_status)) < 0;

    return state;
  });
}

/**
 * Menyimpan nama petugas begitu dipilih, tanpa menunggu konfirmasi.
 *
 * Resep dicetak sebelum barang disiapkan — itu memang gunanya.
 * Tapi nama penyiapnya dulu baru tersimpan saat konfirmasi di akhir,
 * jadi resep selalu tercetak dengan tanda strip di bagian itu.
 *
 * Disimpan sekarang, saat namanya dipilih. Kalau ternyata pesanannya
 * dikerjakan orang lain, namanya tertimpa saat konfirmasi — yang
 * tercatat tetap yang terakhir.
 */
function apiSetPetugas(payload) {
  return withGuard_(payload, { permission: 'ITEM_MARK_PREPARED', lock: 'ringan' }, function (session) {
    var trx = Repo.findOne(DB.SHEET.TRX, 'trx_id', payload.trx_id);
    if (!trx) throw appErr_('NOT_FOUND', 'Transaksi tidak ditemukan.');

    var kode = String(payload.petugas || '').trim();
    if (!kode) {
      Repo.update(DB.SHEET.TRX, trx._row, {
        gudang_petugas: '', gudang_petugas_nama: ''
      });
      return { ok: true, nama: '' };
    }

    var petugas = cariPetugasGudang_(kode);
    if (!petugas) throw appErr_('NO_STAFF', 'Nama petugas tidak dikenal.');

    var patch = {
      gudang_petugas: petugas.code,
      gudang_petugas_nama: petugas.name
    };

    // Untuk pesanan online, namanya juga dicatat sebagai PIC Eksekusi
    if (String(trx.channel || '').toUpperCase() === 'ONLINE') {
      patch.eksekusi_pic = petugas.code;
      patch.eksekusi_pic_nama = petugas.name;
    }

    Repo.update(DB.SHEET.TRX, trx._row, patch);
    return { ok: true, nama: petugas.name };
  });
}
