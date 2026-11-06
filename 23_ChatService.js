/**
 * ELS.ID WORKFLOW SYSTEM
 * File : 23_ChatService.gs
 * Isi  : Percakapan antar divisi yang menempel pada satu transaksi.
 *
 * Koordinasi selama ini lewat WhatsApp: "yang TRX-033 itu gimana?",
 * dijawab setengah jam kemudian, lalu tertimbun pesan lain. Saat
 * ada yang dipertanyakan seminggu kemudian, tidak ada yang bisa
 * ditelusuri.
 *
 * Di sini pesannya menempel pada transaksinya. Siapa pun yang
 * membuka pesanan itu — Sales, Gudang, Eksekusi, Admin, Kasir,
 * Teknisi — melihat percakapan yang sama, lengkap dengan siapa
 * yang menulis dan kapan.
 *
 * Bukan pengganti WhatsApp untuk obrolan umum. Ini khusus satu
 * pesanan, dan justru itu gunanya.
 */

function sheetChatSiap_() {
  var ss = SpreadsheetApp.getActive();
  var sh = ss.getSheetByName(DB.SHEET.CHAT);
  if (sh) return sh;

  sh = ss.insertSheet(DB.SHEET.CHAT);
  var h = DB.HEADERS[DB.SHEET.CHAT];
  sh.getRange(1, 1, 1, h.length).setValues([h])
    .setFontWeight('bold').setBackground('#f1f3f4');
  sh.setFrozenRows(1);
  SpreadsheetApp.flush();
  Repo.clearHeaderCache();

  return sh;
}

/** Mengirim satu pesan pada sebuah transaksi */
function apiChatKirim(payload) {
  return withGuard_(payload, { lock: 'ringan' }, function (session) {
    var pesan = String(payload.pesan || '').trim();
    if (!pesan) throw appErr_('KOSONG', 'Pesannya masih kosong.');
    if (pesan.length > 500) pesan = pesan.substring(0, 500);

    /*
     * Pesan bisa menempel pada transaksi, bisa juga berdiri sendiri.
     *
     * Yang menempel dipakai untuk menanyakan satu pesanan tertentu.
     * Yang berdiri sendiri untuk hal umum antar divisi — "kasir
     * tolong cek pembayaran yang tadi", "sales minta info stok".
     */
    var trx = null;
    if (payload.trx_id) {
      trx = Repo.findOne(DB.SHEET.TRX, 'trx_id', payload.trx_id);
      if (!trx) throw appErr_('NOT_FOUND', 'Transaksi tidak ditemukan.');
    }

    var tujuan = String(payload.tujuan || '').trim().toUpperCase();
    if (!trx && !tujuan) {
      throw appErr_('NO_TUJUAN', 'Pilih dulu divisi yang dituju.');
    }

    sheetChatSiap_();

    var now = nowIso_();
    Repo.append(DB.SHEET.CHAT, {
      chat_id: Util.id('CHT'),
      trx_id: trx ? String(trx.trx_id) : '',
      trx_no: trx ? String(trx.trx_no) : '',
      branch: trx ? String(trx.branch) : String(session.branch),
      tujuan: tujuan,
      role: String(session.role), user_id: String(session.user_id),
      user_name: String(session.full_name),
      pesan: pesan,

      /*
       * Yang menulis dianggap sudah membacanya.
       *
       * Tanpa ini pengirimnya sendiri melihat penanda "belum dibaca"
       * pada pesannya sendiri — dan penanda yang tidak pernah bisa
       * dihilangkan akhirnya diabaikan.
       */
      dibaca: String(session.role),
      created_at: now, is_void: false
    });

    /*
     * Yang sedang memegang pesanan diberi tahu.
     *
     * Pesan tanpa pemberitahuan hanya terbaca kalau kebetulan
     * pesanannya dibuka — dan yang bertanya menunggu jawaban yang
     * tidak pernah tahu dirinya ditanya.
     */
    var dikabari = tujuan
      ? [tujuan]
      : peranPemegang_(trx, session.role);

    dikabari.forEach(function (r) {
      if (r === String(session.role)) return;
      pushNotif_({
        target_role: r,
        target_branch: trx ? trx.branch : session.branch,
        trx_id: trx ? trx.trx_id : '', trx_no: trx ? trx.trx_no : '',
        type: 'CHAT', priority: 'HIGH',
        title: 'Pesan dari ' + String(session.full_name),
        body: (trx ? trx.trx_no + ' · ' : '') + pesan.substring(0, 80)
      });
    });

    flushLog_();

    return { ok: true, chat_id: 'baru' };
  });
}

/**
 * Divisi mana yang perlu tahu ada pesan baru.
 *
 * Yang sedang memegang pesanannya, ditambah Sales yang membuatnya —
 * dia yang paling sering ditanyai customer. Pengirimnya sendiri
 * tidak dikabari.
 */
function peranPemegang_(trx, kecuali) {
  var tahap = String(trx.stage_status);

  var peta = {
    MENUNGGU_GUDANG: ['GUDANG', 'EKSEKUSI'],
    PROSES_GUDANG: ['GUDANG', 'EKSEKUSI'],
    MENUNGGU_BARANG: ['EKSEKUSI', 'ADMIN'],
    SIAP_NOTA: ['ADMIN'],
    MENUNGGU_PEMBAYARAN: ['KASIR'],
    MENUNGGU_AKTIVASI: ['TEKNISI'],
    PROSES_AKTIVASI: ['TEKNISI'],
    AKTIVASI_SELESAI: ['TEKNISI'],
    SIAP_SERAH: ['EKSEKUSI']
  };

  var online = String(trx.channel || '').toUpperCase() === 'ONLINE';
  var daftar = (peta[tahap] || []).filter(function (r) {
    // Pesanan ritel tidak mengganggu Eksekusi, dan sebaliknya
    if (r === 'EKSEKUSI' && !online) return false;
    if (r === 'GUDANG' && online) return false;
    return true;
  });

  daftar.push(online ? 'SALES_ONLINE' : 'SALES');

  var hasil = [];
  daftar.forEach(function (r) {
    if (r === kecuali) return;
    if (hasil.indexOf(r) < 0) hasil.push(r);
  });

  return hasil;
}

/** Seluruh percakapan pada sebuah transaksi */
function apiChatList(payload) {
  return withGuard_(payload, {}, function (session) {
    var trxId = String(payload.trx_id || '');
    if (!trxId) throw appErr_('NO_TRX', 'Transaksi belum ditentukan.');

    var out = [];
    try {
      Repo.findManyFast(DB.SHEET.CHAT, 'trx_id', trxId).forEach(function (c) {
        if (Util.isTrue(c.is_void)) return;
        out.push({
          chat_id: String(c.chat_id),
          role: String(c.role), role_label: Fmt_roleLabel_(c.role),
          user_name: String(c.user_name),
          pesan: String(c.pesan),
          at: Util.isoStr(c.created_at),
          milik_saya: String(c.user_id) === String(session.user_id),
          dibaca: String(c.dibaca || '')
        });
      });
    } catch (e) {
      // Sheetnya belum ada — berarti memang belum pernah ada pesan
      return { list: [], total: 0 };
    }

    out.sort(function (a, b) { return a.at < b.at ? -1 : 1; });

    /*
     * Dibuka berarti dibaca.
     *
     * Ditandai di sini, bukan lewat tombol tersendiri — tombol
     * "tandai sudah dibaca" selalu jadi pekerjaan tambahan yang
     * lama-lama tidak ditekan siapa pun.
     */
    try { tandaiChatDibaca_(trxId, session.role); } catch (e2) {}

    return { list: out, total: out.length };
  });
}

function tandaiChatDibaca_(trxId, peran) {
  var rows = Repo.findManyFast(DB.SHEET.CHAT, 'trx_id', trxId);
  var ubah = [];

  rows.forEach(function (c) {
    if (Util.isTrue(c.is_void)) return;

    var sudah = String(c.dibaca || '').split(',')
      .map(function (x) { return x.trim(); }).filter(function (x) { return x; });

    if (sudah.indexOf(peran) >= 0) return;
    sudah.push(peran);
    ubah.push([c._row, sudah.join(',')]);
  });

  if (ubah.length) Repo.setKolomNilai(DB.SHEET.CHAT, ubah, 'dibaca');
}

/**
 * Jumlah pesan yang belum dibaca divisi ini, per transaksi.
 *
 * Dipakai untuk penanda di daftar — supaya yang perlu dijawab
 * terlihat tanpa membuka satu per satu.
 */
function apiChatBelumDibaca(payload) {
  return withGuard_(payload, {}, function (session) {
    var peran = String(session.role);
    var semuaCabang = hasPerm_(session, 'TRX_VIEW_ALL');
    var perTrx = {};
    var total = 0;

    try {
      Repo.columns(DB.SHEET.CHAT, ['trx_id', 'branch', 'role', 'dibaca', 'is_void'])
        .forEach(function (c) {
          if (Util.isTrue(c.is_void)) return;
          if (String(c.role) === peran) return;
          if (!semuaCabang && String(c.branch) !== String(session.branch)) return;

          var sudah = String(c.dibaca || '').split(',')
            .map(function (x) { return x.trim(); });
          if (sudah.indexOf(peran) >= 0) return;

          var k = String(c.trx_id);
          perTrx[k] = (perTrx[k] || 0) + 1;
          total++;
        });
    } catch (e) {
      return { per_trx: {}, total: 0 };
    }

    return { per_trx: perTrx, total: total };
  });
}

/* ============================================================
   PESAN ANTAR DIVISI

   Tidak menempel pada transaksi mana pun. Dipakai untuk hal yang
   tidak punya nomor pesanan: "stok screen Vivan masih ada?",
   "kasir tolong cek transfer yang tadi".

   Dibuat per pasangan divisi, bukan satu ruang untuk semua. Ruang
   bersama membuat tiap orang membaca pesan yang bukan urusannya,
   dan yang penting tenggelam di antaranya.
   ============================================================ */

function apiPesanDivisi(payload) {
  return withGuard_(payload, {}, function (session) {
    var lawan = String(payload.divisi || '').trim().toUpperCase();
    var peran = String(session.role);

    var out = [];
    try {
      Repo.columns(DB.SHEET.CHAT, [
        'chat_id', 'trx_id', 'trx_no', 'branch', 'role', 'user_id',
        'user_name', 'tujuan', 'pesan', 'created_at', 'dibaca', 'is_void'
      ]).forEach(function (c) {
        if (Util.isTrue(c.is_void)) return;
        if (String(c.trx_id || '').trim()) return;      // itu urusan transaksi

        var dari = String(c.role);
        var ke = String(c.tujuan || '').toUpperCase();

        // Hanya percakapan antara divisi saya dan divisi yang dipilih
        var cocok = (dari === peran && ke === lawan) ||
                    (dari === lawan && ke === peran);
        if (!cocok) return;

        out.push({
          chat_id: String(c.chat_id),
          role: dari, role_label: Fmt_roleLabel_(dari),
          user_name: String(c.user_name),
          pesan: String(c.pesan),
          at: Util.isoStr(c.created_at),
          milik_saya: String(c.user_id) === String(session.user_id) || dari === peran
        });
      });
    } catch (e) {
      return { list: [], total: 0, divisi: lawan };
    }

    out.sort(function (a, b) { return a.at < b.at ? -1 : 1; });

    // Dibuka berarti dibaca
    try { tandaiPesanDibaca_(peran, lawan); } catch (e2) {}

    return { list: out.slice(-80), total: out.length, divisi: lawan };
  });
}

function tandaiPesanDibaca_(peran, lawan) {
  var rows = Repo.all(DB.SHEET.CHAT);
  var ubah = [];

  rows.forEach(function (c) {
    if (Util.isTrue(c.is_void)) return;
    if (String(c.trx_id || '').trim()) return;
    if (String(c.role) !== lawan) return;
    if (String(c.tujuan || '').toUpperCase() !== peran) return;

    var sudah = String(c.dibaca || '').split(',')
      .map(function (x) { return x.trim(); }).filter(function (x) { return x; });

    if (sudah.indexOf(peran) >= 0) return;
    sudah.push(peran);
    ubah.push([c._row, sudah.join(',')]);
  });

  if (ubah.length) Repo.setKolomNilai(DB.SHEET.CHAT, ubah, 'dibaca');
}

/**
 * Ringkasan untuk layar Pesan: berapa yang belum dibaca per divisi.
 *
 * Dipakai untuk penanda di daftar divisi, supaya yang menunggu
 * jawaban terlihat tanpa membuka satu per satu.
 */
function apiPesanRingkas(payload) {
  return withGuard_(payload, {}, function (session) {
    var peran = String(session.role);
    var perDivisi = {}, total = 0, trxBelum = 0;

    try {
      Repo.columns(DB.SHEET.CHAT, [
        'trx_id', 'role', 'tujuan', 'dibaca', 'is_void'
      ]).forEach(function (c) {
        if (Util.isTrue(c.is_void)) return;
        if (String(c.role) === peran) return;

        var sudah = String(c.dibaca || '').split(',')
          .map(function (x) { return x.trim(); });
        if (sudah.indexOf(peran) >= 0) return;

        if (String(c.trx_id || '').trim()) {
          /*
           * Pesan pada transaksi hanya dihitung kalau memang untuk
           * divisi ini — pesan yang ditujukan ke divisi lain tidak
           * perlu jadi penanda di layarnya.
           */
          trxBelum++;
          total++;
          return;
        }

        if (String(c.tujuan || '').toUpperCase() !== peran) return;

        var dari = String(c.role);
        perDivisi[dari] = (perDivisi[dari] || 0) + 1;
        total++;
      });
    } catch (e) {
      return { per_divisi: {}, total: 0, pada_transaksi: 0 };
    }

    return { per_divisi: perDivisi, total: total, pada_transaksi: trxBelum };
  });
}
