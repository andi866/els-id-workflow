/**
 * ELS.ID WORKFLOW SYSTEM
 * File : 22_SnRequestService.gs
 * Isi  : Permintaan tembak SN dari Tim Eksekusi ke Gudang NB.
 *
 * Latar belakangnya: ELS Purwokerto punya dua gedung. Gedung NB
 * punya petugas gudang; gedung PC dan aksesori barangnya terdisplay
 * dan siap jual, jadi Tim Eksekusi mengambilnya sendiri.
 *
 * Untuk pesanan online, Eksekusi yang menyiapkan barangnya. Tapi
 * barang ber-SN ada di gedung NB, dan yang menembak SN tetap Gudang.
 * Tanpa jalan resmi, Eksekusi harus bolak-balik ke gedung sebelah
 * atau menitip lewat WhatsApp yang tidak tercatat di mana pun.
 *
 * Jadi: Eksekusi mengirim permintaan, lalu lanjut menyiapkan barang
 * lain sambil menunggu. Begitu SN terisi, Eksekusi meneruskan
 * pesanannya ke Admin seperti biasa.
 *
 * Yang sengaja TIDAK berubah: pesanan ritel NB. Gudang tetap
 * menyiapkan sekaligus menembak SN seperti sekarang.
 */

function bacaMintaSn_(trx) {
  var f = {};
  try { f = JSON.parse(String(trx.override_flags || '') || '{}'); } catch (e) {}
  return (f.minta_sn && f.minta_sn.length) ? f.minta_sn : [];
}

function tulisMintaSn_(trx, daftar) {
  var f = {};
  try { f = JSON.parse(String(trx.override_flags || '') || '{}'); } catch (e) {}
  f.minta_sn = daftar;

  var teks = JSON.stringify(f);
  Repo.update(DB.SHEET.TRX, trx._row, { override_flags: teks });
  trx.override_flags = teks;
}

function mintaSnTerbuka_(trx) {
  var n = 0;
  bacaMintaSn_(trx).forEach(function (m) {
    if (String(m.status) === 'MENUNGGU') n++;
  });
  return n;
}

/**
 * Eksekusi meminta Gudang menembak SN.
 *
 * Diminta untuk seluruh pesanan sekaligus, bukan per barang. Yang
 * perlu diketahui Gudang cukup: pesanan mana, barang apa saja yang
 * butuh SN. Memecahnya per barang membuat Gudang menerima lima
 * permintaan untuk satu kunjungan ke rak yang sama.
 */
function apiMintaTembakSn(payload) {
  return withGuard_(payload, { permission: 'TRX_CONFIRM_GUDANG', lock: 'ringan' }, function (session) {
    var trx = Repo.findOne(DB.SHEET.TRX, 'trx_id', payload.trx_id);
    if (!trx) throw appErr_('NOT_FOUND', 'Transaksi tidak ditemukan.');
    if (Util.isTrue(trx.is_void)) throw appErr_('VOIDED', 'Transaksi ini sudah dibatalkan.');

    if (['MENUNGGU_GUDANG', 'PROSES_GUDANG'].indexOf(String(trx.stage_status)) < 0) {
      throw appErr_('STAGE_LOCKED',
        'Pesanan ini sudah lewat tahap penyiapan. Status sekarang: ' +
        stageLabel_(trx.stage_status) + '.');
    }

    var daftar = bacaMintaSn_(trx);
    var masihAda = daftar.filter(function (m) { return String(m.status) === 'MENUNGGU'; });
    if (masihAda.length) {
      throw appErr_('ALREADY',
        'Permintaan tembak SN untuk pesanan ini sudah dikirim dan belum dikerjakan Gudang.');
    }

    /*
     * Barang yang dikirim ke Gudang dipilih Eksekusi, bukan ditebak
     * sistem.
     *
     * Semula yang dikirim hanya barang ber-SN. Ternyata keliru: yang
     * sebenarnya terjadi adalah sebagian barang memang ada di gedung
     * NB, dan semuanya perlu diambilkan Gudang — ber-SN atau tidak.
     * Gudang menyiapkannya, mengisi SN yang perlu, lalu menyerahkan
     * ke Eksekusi.
     *
     * Yang tahu barang mana ada di gedung sebelah adalah Eksekusi
     * yang memegang pesanannya, bukan aturan di kode.
     */
    var items = Repo.findManyFast(DB.SHEET.ITEMS, 'trx_id', trx.trx_id)
      .filter(function (i) { return Util.isTrue(i.is_active); });

    var pilih = {};
    (payload.item_ids || []).forEach(function (x) { pilih[String(x)] = true; });

    var butuh = [];
    items.forEach(function (i) {
      if (!pilih[String(i.item_id)]) return;
      butuh.push({
        item_id: String(i.item_id),
        product_code: String(i.product_code),
        product_name: String(i.product_name),
        qty: Number(i.qty) || 1,
        terisi: Number(i.sn_filled_qty) || 0,
        perlu_sn: Util.isTrue(i.need_sn)
      });
    });

    if (!butuh.length) {
      throw appErr_('NO_ITEM',
        'Pilih dulu barang mana yang mau dikirim ke Gudang.');
    }

    var now = nowIso_();
    daftar.push({
      id: Util.id('MSN'),
      status: 'MENUNGGU',
      barang: butuh,
      catatan: String(payload.catatan || '').substring(0, 200),
      minta_by: session.full_name,
      minta_role: String(session.role),
      minta_at: now
    });

    tulisMintaSn_(trx, daftar);

    var ringkas = butuh.map(function (b) {
      return b.product_name + (b.qty > 1 ? ' (' + b.qty + ' unit)' : '') +
        (b.perlu_sn ? ' [SN]' : '');
    }).join(', ');

    logTimeline_(session, {
      trx_id: trx.trx_id, trx_no: trx.trx_no,
      event_code: 'MINTA_SN', stage_after: String(trx.stage_status),
      event_label: session.full_name + ' minta Gudang menembak SN',
      detail: ringkas + (payload.catatan ? ' · ' + payload.catatan : '')
    });

    /*
     * Gudang diberi tahu dengan tingkat tinggi supaya alarmnya
     * berbunyi. Barangnya ditunggu orang di gedung sebelah, dan
     * setiap menit tertahan berarti Eksekusi menunggu tanpa bisa
     * melanjutkan.
     */
    pushNotif_({
      target_role: 'GUDANG', target_branch: trx.branch,
      trx_id: trx.trx_id, trx_no: trx.trx_no,
      type: 'MINTA_SN', priority: 'HIGH',
      title: 'Permintaan barang dari Tim Eksekusi',
      body: trx.trx_no + ' · ' + ringkas +
        (payload.catatan ? ' · ' + payload.catatan : '')
    });

    flushLog_();
    bumpPulse_('GUDANG');

    return {
      ok: true, jumlah: butuh.length,
      pesan: 'Gudang sudah diberi tahu. ' + butuh.length +
             ' barang disiapkan di sana — Anda bisa lanjut menyiapkan yang lain.'
    };
  });
}

/**
 * Gudang menandai SN sudah selesai ditembak.
 *
 * Pengisian SN-nya sendiri memakai layar yang sudah ada, sama seperti
 * pesanan ritel. Yang ditambahkan di sini cuma penutup permintaannya
 * dan pemberitahuan balik ke Eksekusi — supaya yang menunggu tahu
 * barangnya sudah bisa diambil tanpa harus bertanya.
 */
function apiSnSelesai(payload) {
  return withGuard_(payload, { permission: 'SN_INPUT', lock: 'ringan' }, function (session) {
    var trx = Repo.findOne(DB.SHEET.TRX, 'trx_id', payload.trx_id);
    if (!trx) throw appErr_('NOT_FOUND', 'Transaksi tidak ditemukan.');

    /*
     * SN yang baru diketik disimpan dulu.
     *
     * Inilah yang hilang: Gudang mengetik SN lalu menekan "Barang
     * siap", tapi tombol itu hanya menutup permintaannya. Yang
     * menyimpan SN adalah tombol Konfirmasi — dan tombol itu
     * sengaja dimatikan untuk permintaan seperti ini.
     *
     * Jadi SN-nya diketik, hilang, dan tidak ada yang tahu sampai
     * Admin menerbitkan nota tanpa serial number.
     */
    var daftar = bacaMintaSn_(trx);
    var tersimpan = 0;

    if (payload.sn && Object.keys(payload.sn).length) {
      /*
       * Hanya barang yang memang diminta yang ikut disimpan.
       *
       * Gudang melihat sebagian isi pesanan saja; yang lain sudah di
       * tangan Eksekusi. Menyimpan seluruh kiriman apa adanya
       * berisiko menimpa SN barang yang bukan urusannya.
       */
      var bolehItem = {};
      daftar.forEach(function (m) {
        if (String(m.status) !== 'MENUNGGU') return;
        (m.barang || []).forEach(function (b) { bolehItem[String(b.item_id)] = true; });
      });

      var itemsSn = Repo.findManyFast(DB.SHEET.ITEMS, 'trx_id', trx.trx_id)
        .filter(function (i) {
          return Util.isTrue(i.is_active) && bolehItem[String(i.item_id)];
        });

      if (itemsSn.length) {
        /*
         * SN yang bentrok ditolak sebelum apa pun ditulis.
         *
         * Satu serial number tidak boleh menempel pada dua
         * transaksi. Kalau dibiarkan, dua customer memegang nota
         * dengan SN yang sama dan tidak ada yang tahu unit mana
         * milik siapa.
         */
        var masalahSn = periksaSn_(trx, itemsSn, payload.sn);
        if (masalahSn.length) {
          throw appErr_('SN_USED', masalahSn[0].pesan +
            (masalahSn.length > 1
              ? ' (dan ' + (masalahSn.length - 1) + ' SN lain bermasalah)' : ''));
        }

        try {
          var hasilSn = simpanSnBorongan_(session, trx, itemsSn, payload.sn, nowIso_());
          tersimpan = (hasilSn && hasilSn.terisi) || 0;

          /*
           * Salinan dibuang supaya yang lain langsung melihatnya.
           *
           * Tanpa ini, Eksekusi dan Admin masih membaca keadaan
           * sebelum SN diisi — dan menyimpulkan Gudang belum
           * mengerjakannya, padahal sudah.
           */
          try { Repo.bustSheet(DB.SHEET.SN); } catch (eB1) {}
          try { Repo.bustSheet(DB.SHEET.ITEMS); } catch (eB2) {}

          recalcTrx_(trx.trx_id);
        } catch (eS) {
          throw appErr_('SN_GAGAL',
            'Serial number gagal disimpan: ' + (eS && eS.message ? eS.message : eS));
        }
      }
    }

    var ketemu = -1;
    for (var i = 0; i < daftar.length; i++) {
      if (String(daftar[i].status) !== 'MENUNGGU') continue;
      if (payload.minta_id && String(daftar[i].id) !== String(payload.minta_id)) continue;
      ketemu = i; break;
    }

    if (ketemu < 0) throw appErr_('NOT_FOUND', 'Tidak ada permintaan yang masih menunggu.');

    /*
     * Diperiksa dulu SN-nya memang sudah terisi.
     *
     * Kalau ditandai selesai padahal belum diisi, Eksekusi meneruskan
     * pesanan tanpa SN dan baru ketahuan di Admin — saat barangnya
     * sudah dibungkus.
     */
    try { Repo.bustSheet(DB.SHEET.ITEMS); } catch (eB3) {}

    var items = Repo.findManyFast(DB.SHEET.ITEMS, 'trx_id', trx.trx_id);
    var peta = {};
    items.forEach(function (i) { peta[String(i.item_id)] = i; });

    var belum = [];
    (daftar[ketemu].barang || []).forEach(function (b) {
      var it = peta[String(b.item_id)];
      if (!it) return;

      // Barang tanpa SN cukup disiapkan, tidak ada yang diperiksa
      if (!Util.isTrue(it.need_sn)) return;

      var terisi = Number(it.sn_filled_qty) || 0;
      if (terisi < (Number(it.qty) || 1)) {
        belum.push(String(it.product_name) + ' (' + terisi + '/' + (it.qty || 1) + ')');
      }
    });

    if (belum.length && !Util.isTrue(payload.abaikan)) {
      throw appErr_('SN_BELUM',
        'Masih ada yang belum lengkap SN-nya: ' + belum.join(', ') + '. ' +
        'Isi dulu, atau tandai selesai dengan keterangan kalau barangnya memang tanpa SN.');
    }

    var now = nowIso_();
    daftar[ketemu].status = 'SELESAI';
    daftar[ketemu].isi_by = session.full_name;
    daftar[ketemu].isi_at = now;
    if (payload.catatan) {
      daftar[ketemu].catatan_gudang = String(payload.catatan).substring(0, 200);
    }

    tulisMintaSn_(trx, daftar);

    logTimeline_(session, {
      trx_id: trx.trx_id, trx_no: trx.trx_no,
      event_code: 'SN_SELESAI', stage_after: String(trx.stage_status),
      event_label: session.full_name + ' selesai menembak SN',
      detail: 'Diminta ' + String(daftar[ketemu].minta_by || '') +
        (payload.catatan ? ' · ' + payload.catatan : '')
    });

    pushNotif_({
      target_role: String(daftar[ketemu].minta_role || 'EKSEKUSI'),
      target_branch: trx.branch,
      trx_id: trx.trx_id, trx_no: trx.trx_no,
      type: 'SN_SELESAI', priority: 'HIGH',
      title: 'Barang sudah disiapkan Gudang',
      body: trx.trx_no + ' · ' + String(trx.cust_name_snap) +
        ' · bisa diambil di Gudang NB'
    });

    flushLog_();
    bumpPulse_('EKSEKUSI');

    return {
      ok: true, tersimpan: tersimpan,
      pesan: tersimpan
        ? tersimpan + ' serial number tersimpan. Eksekusi sudah diberi tahu.'
        : 'Eksekusi sudah diberi tahu.'
    };
  });
}

/** Membatalkan permintaan — dipakai kalau ternyata salah kirim */
function apiBatalMintaSn(payload) {
  return withGuard_(payload, { permission: 'TRX_CONFIRM_GUDANG', lock: 'ringan' }, function (session) {
    var trx = Repo.findOne(DB.SHEET.TRX, 'trx_id', payload.trx_id);
    if (!trx) throw appErr_('NOT_FOUND', 'Transaksi tidak ditemukan.');

    var daftar = bacaMintaSn_(trx);
    var ada = false;

    daftar.forEach(function (m, i) {
      if (String(m.status) !== 'MENUNGGU') return;
      daftar[i].status = 'BATAL';
      daftar[i].batal_by = session.full_name;
      daftar[i].batal_at = nowIso_();
      ada = true;
    });

    if (!ada) throw appErr_('NOT_FOUND', 'Tidak ada permintaan yang bisa dibatalkan.');

    tulisMintaSn_(trx, daftar);
    bumpPulse_('GUDANG');

    return { ok: true };
  });
}

// ============================================================
// PENYERAHAN BARANG OLEH TIM EKSEKUSI
//
// Untuk pesanan yang tidak perlu lewat Teknisi. Barangnya sudah
// siap, notanya sudah terbit, pembayarannya sudah diurus Kasir —
// tinggal diserahkan.
//
// Caranya mengikuti yang dipilih Sales Online saat membuat pesanan:
// diambil customer, dikirim driver, atau lewat ekspedisi. Dua yang
// terakhir perlu nama driver atau nomor resi, supaya kalau barangnya
// dipertanyakan ada yang bisa ditelusuri.
// ============================================================

function apiSerahEksekusi(payload) {
  return withGuard_(payload, { permission: 'TRX_CONFIRM_GUDANG', lock: 'ringan' }, function (session) {
    var trx = Repo.findOne(DB.SHEET.TRX, 'trx_id', payload.trx_id);
    if (!trx) throw appErr_('NOT_FOUND', 'Transaksi tidak ditemukan.');
    if (Util.isTrue(trx.is_void)) throw appErr_('VOIDED', 'Transaksi ini sudah dibatalkan.');

    if (String(trx.stage_status) !== 'SIAP_SERAH') {
      throw appErr_('STAGE_LOCKED',
        'Pesanan ini belum siap diserahkan. Status sekarang: ' +
        stageLabel_(trx.stage_status) + '.');
    }

    var cara = String(payload.metode || trx.metode_serah || 'DI-AMBIL').toUpperCase();
    var butuhJejak = cara.indexOf('DRIVER') >= 0 || cara.indexOf('PAKET') >= 0 ||
                     cara.indexOf('GOSEND') >= 0 || cara.indexOf('GRAB') >= 0;

    var driver = String(payload.driver || '').trim();
    var resi = String(payload.resi || '').trim();

    if (butuhJejak && !driver && !resi) {
      throw appErr_('NO_TRACK',
        'Barang ini dikirim, jadi tulis dulu nama driver atau nomor resinya. ' +
        'Tanpa itu tidak ada yang bisa ditelusuri kalau customer bertanya.');
    }

    var now = nowIso_();
    var flags = {};
    try { flags = JSON.parse(String(trx.override_flags || '') || '{}'); } catch (e) {}

    flags.diserahkan = {
      at: now, by: session.full_name, user_id: session.user_id,
      note: String(payload.catatan || '').trim(),
      cara: cara, driver: driver, resi: resi
    };

    bumpRevision_(session, trx, {
      stage_status: 'SELESAI',
      completed_at: now,
      serah_driver: driver,
      serah_resi: resi,
      override_flags: JSON.stringify(flags)
    });

    logTimeline_(session, {
      trx_id: trx.trx_id, trx_no: trx.trx_no,
      event_code: 'DISERAHKAN', stage_after: 'SELESAI',
      event_label: session.full_name + ' menyerahkan barang · ' + cara,
      detail: (driver ? 'Driver ' + driver : '') + (resi ? ' Resi ' + resi : '') +
        (payload.catatan ? ' · ' + payload.catatan : '')
    });

    pushNotif_({
      target_role: 'ADMIN', target_branch: trx.branch,
      trx_id: trx.trx_id, trx_no: trx.trx_no,
      type: 'DONE', priority: 'NORMAL',
      title: 'Pesanan online selesai',
      body: trx.trx_no + ' · ' + String(trx.cust_name_snap) + ' · ' + cara
    });

    flushLog_();

    return { ok: true, trx_no: String(trx.trx_no), cara: cara };
  });
}

/** Daftar pesanan yang tinggal diserahkan */
function apiSiapSerah(payload) {
  return withGuard_(payload, { permission: 'TRX_VIEW_STAGE' }, function (session) {
    var semuaCabang = hasPerm_(session, 'TRX_VIEW_ALL');
    var sekarang = new Date().getTime();
    var out = [];

    Repo.columns(DB.SHEET.TRX, [
      'trx_id', 'trx_no', 'branch', 'cust_name_snap', 'cust_phone_snap',
      'sales_name', 'stage_status', 'payment_status', 'item_count',
      'grand_total', 'outstanding', 'nota_no', 'channel', 'metode_serah',
      'tempo_hari', 'updated_at', 'is_void'
    ]).forEach(function (t) {
      if (Util.isTrue(t.is_void)) return;
      if (String(t.stage_status) !== 'SIAP_SERAH') return;
      if (!semuaCabang && String(t.branch) !== String(session.branch)) return;

      var sejak = t.updated_at ? new Date(Util.isoStr(t.updated_at)).getTime() : sekarang;

      out.push({
        trx_id: String(t.trx_id), trx_no: String(t.trx_no),
        cust_name: String(t.cust_name_snap), cust_phone: Util.hp(t.cust_phone_snap),
        sales_name: String(t.sales_name || ''),
        nota_no: String(t.nota_no || ''),
        item_count: Number(t.item_count) || 0,
        grand_total: Number(t.grand_total) || 0,
        outstanding: Number(t.outstanding) || 0,
        payment_status: String(t.payment_status),
        metode_serah: String(t.metode_serah || 'DI-AMBIL'),
        tempo_hari: Number(t.tempo_hari) || 0,
        menit: Math.max(Math.round((sekarang - sejak) / 60000), 0)
      });
    });

    out.sort(function (a, b) { return b.menit - a.menit; });
    return { list: out, total: out.length };
  });
}

// ============================================================
// CARI PESANAN LAMA
//
// Pesanan ditanyakan lagi berbulan-bulan kemudian — customer
// menelepon menanyakan garansi, atau menanyakan pesanan yang dulu.
//
// Yang dicari bisa ada di dua tempat: masih di sheet utama, atau
// sudah dipindah ke berkas arsip harian. Dicari di keduanya
// sekaligus, supaya yang bertanya tidak perlu tahu bedanya.
// ============================================================

function apiCariPesanan(payload) {
  return withGuard_(payload, {}, function (session) {
    var q = String(payload.q || '').trim().toUpperCase();
    if (q.length < 3) {
      throw appErr_('TOO_SHORT',
        'Ketik minimal 3 huruf — nama customer, nomor transaksi, atau nomor nota.');
    }

    var boleh = hasPerm_(session, 'TRX_VIEW_OWN') || hasPerm_(session, 'TRX_VIEW_STAGE');
    if (!boleh) throw appErr_('FORBIDDEN', 'Anda tidak punya akses ke daftar ini.');

    var semuaCabang = hasPerm_(session, 'TRX_VIEW_ALL');
    var peran = String(session.role);

    /*
     * Disaring per divisi, sama seperti daftar lainnya.
     *
     * Sales Online dan Eksekusi mencari pesanan online; Sales NB dan
     * Gudang mencari ritel. Tanpa ini, pencarian jadi pintu belakang
     * untuk melihat penjualan divisi lain — persis yang kita tutup
     * di Pesanan Saya.
     */
    var hanya = '';
    if (peran === 'SALES' || peran === 'GUDANG') hanya = 'RITEL';
    else if (peran === 'SALES_ONLINE' || peran === 'EKSEKUSI') hanya = 'ONLINE';

    var cocok = function (bahan) {
      return bahan.join(' ').toUpperCase().indexOf(q) >= 0;
    };

    var out = [];

    /* ---------- yang masih di sheet utama ---------- */
    Repo.columns(DB.SHEET.TRX, [
      'trx_id', 'trx_no', 'branch', 'trx_date', 'cust_name_snap', 'cust_phone_snap',
      'sales_name', 'stage_status', 'payment_status', 'item_count', 'grand_total',
      'nota_no', 'nota_indent', 'channel', 'metode_serah', 'is_void'
    ]).forEach(function (t) {
      if (!semuaCabang && String(t.branch) !== String(session.branch)) return;

      var ch = String(t.channel || 'RITEL').toUpperCase();
      if (hanya === 'RITEL' && ch === 'ONLINE') return;
      if (hanya === 'ONLINE' && ch !== 'ONLINE') return;

      if (!cocok([t.trx_no, t.cust_name_snap, t.cust_phone_snap,
                  t.nota_no, t.nota_indent, t.sales_name])) return;

      out.push({
        trx_id: String(t.trx_id), trx_no: String(t.trx_no),
        tanggal: Util.dateStr(t.trx_date),
        cust_name: String(t.cust_name_snap), cust_phone: Util.hp(t.cust_phone_snap),
        sales_name: String(t.sales_name || ''),
        stage_label: stageLabelCh_(t.stage_status, t.channel),
        stage_status: String(t.stage_status),
        payment_status: String(t.payment_status),
        item_count: Number(t.item_count) || 0,
        grand_total: Number(t.grand_total) || 0,
        nota_no: String(t.nota_no || t.nota_indent || ''),
        metode_serah: String(t.metode_serah || ''),
        dibatalkan: Util.isTrue(t.is_void),
        arsip: false, tautan: ''
      });
    });

    /* ---------- yang sudah diarsipkan ---------- */
    try {
      var shIdx = SpreadsheetApp.getActive().getSheetByName('ARSIP_INDEX');
      if (shIdx && shIdx.getLastRow() > 1) {
        shIdx.getRange(2, 1, shIdx.getLastRow() - 1, 10).getValues()
          .forEach(function (r) {
            if (!cocok([r[0], r[2], r[3], r[6]])) return;

            out.push({
              trx_id: '', trx_no: String(r[0]),
              tanggal: String(r[1]),
              cust_name: String(r[2]), cust_phone: '',
              sales_name: String(r[3]),
              stage_label: 'Diarsipkan',
              stage_status: 'ARSIP',
              payment_status: 'LUNAS',
              item_count: 0,
              grand_total: Number(r[4]) || 0,
              nota_no: String(r[6] || ''),
              metode_serah: '',
              dibatalkan: false,
              arsip: true, berkas: String(r[7] || ''), tautan: String(r[8] || '')
            });
          });
      }
    } catch (e) {}

    out.sort(function (a, b) { return a.tanggal < b.tanggal ? 1 : -1; });

    return {
      list: out.slice(0, 60), total: out.length,
      di_arsip: out.filter(function (x) { return x.arsip; }).length
    };
  });
}
