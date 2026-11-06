/**
 * ELS.ID WORKFLOW SYSTEM — Phase 7
 * File : 14_TechService.gs
 * Isi  : Antrian aktivasi, proses aktivasi, dan pemanggilan customer.
 *
 * Aturan yang dipegang file ini:
 * - Aktivasi hanya boleh dimulai kalau transaksi sudah LUNAS.
 *   Super Admin boleh menembusnya, tapi wajib mengisi alasan dan
 *   tercatat sebagai override.
 * - Waktu mulai dan selesai dicatat, supaya lama pengerjaan terukur.
 * - Pemanggilan customer punya jeda minimal, supaya tidak jadi alat
 *   menekan customer yang sedang di kamar kecil.
 */

// ============================================================
// PEMBACA
// ============================================================

/*
 * Pemeriksaan nomor revisi pada tindakan Teknisi.
 *
 * Nomor revisi dipakai untuk mencegah dua orang mengubah data yang
 * sama tanpa saling tahu. Itu benar untuk pengubahan barang atau
 * harga — tapi tindakan Teknisi tidak mengubah apa pun selain tahap.
 *
 * Sejak penyimpanan berjalan di latar belakang, layar Teknisi
 * memegang nomor revisi dari SEBELUM "Mulai aktivasi" tersimpan.
 * Begitu dia menekan "Aktivasi selesai" beberapa detik kemudian,
 * nomor yang dikirim sudah tertinggal satu — dan permintaannya
 * ditolak dengan pesan minta diulang.
 *
 * Makin cepat Teknisi bekerja, makin sering gagal. Itu kebalikan
 * dari yang seharusnya.
 */
function loadTrxForTeknisi_(session, trxId, expectedRevision) {
  var trx = Repo.findOne(DB.SHEET.TRX, 'trx_id', trxId);
  if (!trx) throw appErr_('NOT_FOUND', 'Transaksi tidak ditemukan.');
  if (Util.isTrue(trx.is_void)) throw appErr_('VOIDED', 'Transaksi ini sudah dibatalkan.');

  if (String(trx.branch) !== String(session.branch) && !hasPerm_(session, 'TRX_VIEW_ALL')) {
    throw appErr_('OTHER_BRANCH', 'Transaksi ini milik cabang lain.');
  }

  if (expectedRevision !== undefined && expectedRevision !== null && expectedRevision !== '') {
    if (Number(expectedRevision) !== (Number(trx.revision) || 0)) {
      throw appErr_('STALE_DATA',
        'Transaksi sudah diperbarui oleh ' + (trx.updated_by_name || 'orang lain') +
        '. Layar dimuat ulang supaya Anda lihat versi terbaru.');
    }
  }
  return trx;
}

function dataTeknisi_(session, trxId) {
  var trx = Repo.findOne(DB.SHEET.TRX, 'trx_id', trxId);
  if (!trx) throw appErr_('NOT_FOUND', 'Transaksi tidak ditemukan.');

  var snPerItem = {};
  Repo.findManyFast(DB.SHEET.SN, 'trx_id', trxId).forEach(function (s) {
    if (!Util.isTrue(s.is_active)) return;
    var k = String(s.item_id);
    if (!snPerItem[k]) snPerItem[k] = [];
    snPerItem[k].push({ seq: Number(s.unit_seq), sn: String(s.serial_number) });
  });

  var items = Repo.findManyFast(DB.SHEET.ITEMS, 'trx_id', trxId)
    .filter(function (i) { return Util.isTrue(i.is_active); })
    .sort(function (a, b) { return Number(a.line_no) - Number(b.line_no); })
    .map(function (i) {
      var daftar = (snPerItem[String(i.item_id)] || [])
        .sort(function (a, b) { return a.seq - b.seq; });
      var qty = Number(i.qty) || 0;
      var sns = [];
      for (var u = 1; u <= qty; u++) {
        var ada = daftar.filter(function (x) { return x.seq === u; })[0];
        sns.push(ada ? ada.sn : '');
      }
      return {
        item_id: String(i.item_id), product_code: String(i.product_code),
        product_name: String(i.product_name), qty: qty,
        sns: sns, item_note: String(i.item_note || ''),
        source: String(i.source)
      };
    });

  var flags = {};
  try { flags = JSON.parse(String(trx.override_flags || '') || '{}'); } catch (e) {}
  var panggil = flags.panggil || null;
  var diserahkan = flags.diserahkan || null;
  var jeda = Settings.num('RECALL_COOLDOWN_SEC', 120);
  var sisaJeda = 0;
  if (panggil && panggil.at) {
    var lewat = Math.round((new Date().getTime() - new Date(panggil.at).getTime()) / 1000);
    sisaJeda = Math.max(jeda - lewat, 0);
  }

  var mulai = Util.isoStr(trx.activation_start_at);
  var selesai = Util.isoStr(trx.activation_done_at);
  /*
   * Lama pengerjaan, dengan penjagaan terhadap tanggal yang tidak
   * terbaca.
   *
   * Kalau tanggal mulainya tersimpan dalam bentuk yang tidak bisa
   * dibaca, pengurangannya menghasilkan bukan-angka — dan di layar
   * tertulis "NaN menit", yang tidak berarti apa-apa bagi siapa pun
   * yang membacanya.
   */
  var durasi = 0;
  if (mulai) {
    var awalMs = new Date(mulai).getTime();
    var akhirMs = selesai ? new Date(selesai).getTime() : new Date().getTime();

    if (!isNaN(awalMs) && !isNaN(akhirMs)) {
      durasi = Math.max(Math.round((akhirMs - awalMs) / 60000), 0);
    }
  }

  return {
    header: {
      trx_id: String(trx.trx_id), trx_no: String(trx.trx_no),
      nota_no: String(trx.nota_no || ''),

      // Nama teknisi yang memegang unit ini
      tech_nama: String(trx.tech_petugas_nama || ''),
      kerja_teknisi: String(trx.kerja_teknisi || ''),
      channel: String(trx.channel || 'RITEL'),
      tech_kode: String(trx.tech_petugas || ''),

      cust_name: String(trx.cust_name_snap), cust_phone: Util.hp(trx.cust_phone_snap),
      sales_name: String(trx.sales_name || ''),
      order_note: String(trx.order_note || ''),
      stage_status: String(trx.stage_status), stage_label: stageLabel_(trx.stage_status),
      payment_status: String(trx.payment_status),
      grand_total: Number(trx.grand_total) || 0,
      paid_total: Number(trx.paid_total) || 0,
      outstanding: Number(trx.outstanding) || 0,
      revision: Number(trx.revision) || 0,
      activation_start_at: mulai,
      activation_done_at: selesai,
      durasi_menit: durasi,
      tech_user_id: String(trx.tech_user_id || ''),
      item_count: items.length,
      panggil_terakhir: panggil ? { at: String(panggil.at), by: String(panggil.by || ''),
                                    jumlah: Number(panggil.jumlah) || 1 } : null,
      sisa_jeda_panggil: sisaJeda,
      diserahkan: diserahkan ? { at: String(diserahkan.at), by: String(diserahkan.by || '') } : null,
      /*
       * Boleh dikerjakan — belum tentu sudah lunas.
       *
       * Yang menahan pekerjaan Teknisi selama ini pembayaran. Padahal
       * yang benar-benar tidak boleh terjadi adalah barang keluar
       * sebelum dibayar — bukan barang dirakit sebelum dibayar.
       *
       * Jadi kalau pengaturan "Teknisi sebelum Kasir" dinyalakan,
       * pekerjaannya boleh jalan untuk semua saluran, ritel maupun
       * online. Penyerahannya tetap dijaga terpisah dan tetap
       * menunggu lunas.
       */
      lunas: String(trx.payment_status) === 'LUNAS' ||
             !!String(trx.tempo_jatuh || '').trim() ||
             Util.isTrue(trx.tek_dulu) ||
             Util.isTrue(Settings.get('TEKNISI_SEBELUM_KASIR', 'FALSE')),

      // Dipakai layar untuk membedakan "boleh kerja" dari "sudah bayar"
      sudah_bayar: String(trx.payment_status) === 'LUNAS' ||
                   !!String(trx.tempo_jatuh || '').trim(),

      // Ditampilkan terpisah supaya Teknisi tahu ini tempo, bukan lunas
      tempo_jatuh: Util.dateStr(trx.tempo_jatuh),
      tempo_hari: Number(trx.tempo_hari) || 0,

      // Dikerjakan lebih dulu atas permintaan customer, notanya
      // belum terbit — setelah selesai kembali ke Admin
      tek_dulu: Util.isTrue(trx.tek_dulu),
      catatan_teknisi: String(trx.catatan_teknisi || '')
    },
    items: items,
    ganti: (function () {
      try {
        return bacaGanti_(trx).map(function (g) {
          return {
            id: String(g.id), product_name: String(g.product_name),
            unit_seq: Number(g.unit_seq) || 1, status: String(g.status),
            status_label: labelStatusGanti_(g.status),
            sn_baru: String(g.sn_baru || ''), nota_ganti: String(g.nota_ganti || ''),
            alasan: String(g.alasan || '')
          };
        });
      } catch (e) { return []; }
    })(),
    bisaKoreksiSn: hasPerm_(session, 'SN_INPUT'),
    bisaOverride: hasPerm_(session, 'GUARD_OVERRIDE')
  };
}

// ============================================================
// API — ANTRIAN
// ============================================================

function apiTeknisiQueue(payload) {
  return withGuard_(payload, { permission: 'ACTIVATION_START' }, function (session) {
    var scope = String(payload.scope || 'antri');
    var semuaCabang = hasPerm_(session, 'TRX_VIEW_ALL');
    var today = Util.todayStr();
    var sekarang = new Date().getTime();

    var rows = Repo.columns(DB.SHEET.TRX, [
      'trx_id', 'trx_no', 'branch', 'trx_date', 'cust_name_snap', 'cust_phone_snap',
      'sales_name', 'stage_status', 'payment_status', 'item_count',
      'nota_no', 'paid_at', 'activation_start_at', 'activation_done_at',
      'tech_user_id', 'tech_petugas_nama', 'kerja_teknisi', 'channel',
      'tempo_hari', 'tempo_jatuh', 'tek_dulu', 'catatan_teknisi',
      'order_note', 'override_flags', 'is_void'
    ]);

    var out = [], rekap = { antri: 0, proses: 0, selesaiHariIni: 0,
                            menungguAmbil: 0, belumLunas: 0 };

    for (var i = 0; i < rows.length; i++) {
      var t = rows[i];
      if (Util.isTrue(t.is_void)) continue;
      if (!semuaCabang && String(t.branch) !== String(session.branch)) continue;

      var stage = String(t.stage_status);
      var relevan = ['MENUNGGU_AKTIVASI', 'PROSES_AKTIVASI', 'AKTIVASI_SELESAI', 'SELESAI']
                      .indexOf(stage) >= 0;
      if (!relevan) continue;

      var flagsAwal = {};
      try { flagsAwal = JSON.parse(String(t.override_flags || '') || '{}'); } catch (e) {}
      var sudahDiserahkan = !!(flagsAwal.diserahkan && flagsAwal.diserahkan.at);
      var selesaiHariIni = Util.dateStr(t.activation_done_at) === today;

      /*
       * Selesai aktivasi tapi barang belum diserahkan — customer
       * biasanya duduk lagi di ruang tunggu dan perlu dipanggil.
       *
       * Tidak dibatasi hari ini saja. Unit yang terlewat ditandai
       * kemarin akan hilang dari layar hari ini kalau dibatasi, dan
       * tidak ada lagi yang mengingatkan bahwa barangnya masih
       * menggantung. Justru yang sudah lewat hari itu yang paling
       * perlu ditindak.
       */
      var menungguAmbil = (stage === 'SELESAI' || stage === 'AKTIVASI_SELESAI') &&
                          !sudahDiserahkan;

      if (stage === 'MENUNGGU_AKTIVASI') rekap.antri++;
      else if (stage === 'PROSES_AKTIVASI') rekap.proses++;
      else if (selesaiHariIni) rekap.selesaiHariIni++;
      if (menungguAmbil) rekap.menungguAmbil = (rekap.menungguAmbil || 0) + 1;
      if (String(t.payment_status) !== 'LUNAS' && stage !== 'SELESAI') rekap.belumLunas++;

      var masuk = false;
      if (scope === 'antri') masuk = stage === 'MENUNGGU_AKTIVASI' || stage === 'PROSES_AKTIVASI';
      else if (scope === 'proses') masuk = stage === 'PROSES_AKTIVASI';
      else if (scope === 'ambil') masuk = menungguAmbil;
      else if (scope === 'panggil') masuk = stage === 'MENUNGGU_AKTIVASI' ||
                                            stage === 'PROSES_AKTIVASI' || menungguAmbil;
      else if (scope === 'selesai') masuk = selesaiHariIni;
      else masuk = true;
      if (!masuk) continue;

      var acuan = t.paid_at ? new Date(Util.isoStr(t.paid_at)).getTime() : sekarang;
      var menit = Math.max(Math.round((sekarang - acuan) / 60000), 0);

      var flags = flagsAwal;

      out.push({
        menunggu_ambil: menungguAmbil,
        sudah_diserahkan: sudahDiserahkan,
        trx_id: String(t.trx_id), trx_no: String(t.trx_no),
        nota_no: String(t.nota_no || ''),
        cust_name: String(t.cust_name_snap), cust_phone: Util.hp(t.cust_phone_snap),
        sales_name: String(t.sales_name || ''),

        // Siapa yang sedang atau sudah mengerjakan — supaya tidak ada
        // dua orang menggarap unit yang sama tanpa saling tahu
        tech_nama: String(t.tech_petugas_nama || ''),

        // Pekerjaan yang diminta Eksekusi — aktivasi, rakit, cek unit
        kerja_teknisi: String(t.kerja_teknisi || ''),
        channel: String(t.channel || 'RITEL'),
        tempo_hari: Number(t.tempo_hari) || 0,
        tempo_jatuh: Util.dateStr(t.tempo_jatuh),
        tek_dulu: Util.isTrue(t.tek_dulu),
        catatan_teknisi: String(t.catatan_teknisi || ''),

        stage_status: stage, stage_label: stageLabel_(stage),
        payment_status: String(t.payment_status),
        item_count: Number(t.item_count) || 0,
        order_note: String(t.order_note || ''),
        menunggu_menit: menit,
        start_at: Util.isoStr(t.activation_start_at),
        done_at: Util.isoStr(t.activation_done_at),
        sudah_dipanggil: !!(flags.panggil && flags.panggil.at)
      });
    }

    var urutan = function (x) {
      if (x.menunggu_ambil) return 0;          // paling perlu dipanggil
      if (x.stage_status === 'PROSES_AKTIVASI') return 1;
      if (x.stage_status === 'MENUNGGU_AKTIVASI') return 2;
      return 3;
    };
    out.sort(function (a, b) {
      var ua = urutan(a), ub = urutan(b);
      if (ua !== ub) return ua - ub;
      return b.menunggu_menit - a.menunggu_menit;
    });

    return { list: out.slice(0, 120), total: out.length, rekap: rekap };
  });
}

function apiTeknisiGetTrx(payload) {
  return withGuard_(payload, { permission: 'ACTIVATION_START' }, function (session) {
    return dataTeknisi_(session, payload.trx_id);
  });
}

// ============================================================
// API — MULAI AKTIVASI
// ============================================================

function apiStartActivation(payload) {
  return withGuard_(payload, { permission: 'ACTIVATION_START', lock: 'ringan' }, function (session) {
    var jam = Jam.mulai('apiStartActivation');
    // Nomor revisi sengaja tidak diperiksa — lihat keterangan di atas
    var trx = loadTrxForTeknisi_(session, payload.trx_id, null);
    var stage = String(trx.stage_status);

    if (stage === 'PROSES_AKTIVASI') return dataTeknisi_(session, trx.trx_id);

    if (stage !== 'MENUNGGU_AKTIVASI') {
      throw appErr_('STAGE_LOCKED',
        'Transaksi ini berstatus "' + stageLabel_(stage) + '", belum siap diaktivasi.');
    }

    /*
     * Lunas, atau tempo yang sudah disetujui Kasir.
     *
     * Aturan "tidak boleh dikerjakan sebelum lunas" dibuat supaya
     * barang tidak keluar tanpa pembayaran. Tempo adalah pengecualian
     * yang memang sah — dan sudah melewati persetujuan Kasir, yang
     * namanya tercatat.
     *
     * Tanpa ini pesanan tempo mentok di Teknisi: Kasir sudah
     * menyetujui, barangnya boleh jalan, tapi tidak ada yang bisa
     * mengerjakannya.
     */
    /*
     * Saklar "Teknisi sebelum Kasir" ikut dibaca di sini.
     *
     * Inilah yang masih menahan: layarnya sudah mengizinkan, tapi
     * penjaga di server ini belum tahu soal saklar itu — jadi
     * tombolnya bisa ditekan dan langsung ditolak. Lebih
     * membingungkan daripada kalau tombolnya memang tidak ada.
     *
     * Yang tetap dijaga tinggal satu: barang tidak boleh keluar
     * sebelum dibayar. Penjaga itu ada di penyerahan, bukan di
     * sini — dan memang di situ tempatnya.
     */
    var lunas = String(trx.payment_status) === 'LUNAS' ||
                !!String(trx.tempo_jatuh || '').trim() ||
                Util.isTrue(trx.tek_dulu) ||
                Util.isTrue(Settings.get('TEKNISI_SEBELUM_KASIR', 'FALSE'));

    var pakaiOverride = false;

    if (!lunas) {
      if (!hasPerm_(session, 'GUARD_OVERRIDE')) {
        throw appErr_('NOT_PAID',
          'Transaksi belum lunas. Sisa ' + formatRp_(trx.outstanding) +
          '. Hubungi Super Admin kalau memang perlu diaktivasi lebih dulu.');
      }
      var alasan = String(payload.alasan || '').trim();
      if (alasan.length < 4) {
        throw appErr_('NO_REASON',
          'Transaksi belum lunas. Alasan wajib diisi kalau tetap ingin diaktivasi.');
      }
      pakaiOverride = true;

      var flags = {};
      try { flags = JSON.parse(String(trx.override_flags || '') || '{}'); } catch (e) {}
      flags.aktivasi_sebelum_lunas = {
        by: session.user_id, name: session.full_name,
        at: nowIso_(), reason: alasan, sisa: Number(trx.outstanding) || 0
      };
      Repo.update(DB.SHEET.TRX, trx._row, { override_flags: JSON.stringify(flags) });

      logAudit_(session, {
        entity: 'TRX', entity_id: trx.trx_id, trx_no: trx.trx_no,
        action: 'OVERRIDE', field: 'aktivasi_sebelum_lunas',
        old_value: 'sisa ' + formatRp_(trx.outstanding), new_value: 'diizinkan',
        reason: alasan
      });
    }

    var now = nowIso_();
    /*
     * Nama teknisi yang mengerjakan disimpan di transaksinya.
     *
     * Akun Teknisi dipakai bersama satu meja, jadi akun login tidak
     * memberi tahu siapa yang benar-benar mengerjakan. Tanpa ini,
     * laporan bulanan tidak bisa dipecah per orang — dan itu yang
     * selama ini membuat laporannya harus diisi manual lewat
     * formulir terpisah.
     */
    /*
     * Nama teknisi wajib, bukan pilihan.
     *
     * Kalau boleh dikosongkan, pekerjaannya tidak terhitung ke
     * siapa pun — dan baru ketahuan akhir bulan saat laporannya
     * tidak cocok. Lebih baik ditahan sekarang, saat orangnya
     * masih di depan layar dan tinggal memilih satu nama.
     */
    var petugas = cariTeknisi_(payload.tech_code);
    if (!petugas) {
      throw appErr_('NO_TECH',
        'Pilih dulu nama teknisi yang mengerjakan. Tanpa itu pekerjaannya ' +
        'tidak masuk laporan bulanan siapa pun.');
    }

    bumpRevision_(session, trx, {
      stage_status: 'PROSES_AKTIVASI',
      tech_user_id: session.user_id,
      tech_petugas: petugas ? petugas.code : '',
      tech_petugas_nama: petugas ? petugas.name : '',
      activation_start_at: now
    });

    logAudit_(session, {
      entity: 'TRX', entity_id: trx.trx_id, trx_no: trx.trx_no,
      action: 'STAGE_CHANGE', field: 'stage_status',
      old_value: 'MENUNGGU_AKTIVASI', new_value: 'PROSES_AKTIVASI'
    });
    logTimeline_(session, {
      trx_id: trx.trx_id, trx_no: trx.trx_no,
      event_code: 'ACTIVATION_START', stage_after: 'PROSES_AKTIVASI',
      event_label: 'Teknisi ' + session.full_name + ' mulai aktivasi' +
        (pakaiOverride ? ' (belum lunas, diizinkan Super Admin)' : ''),
      detail: pakaiOverride ? String(payload.alasan || '') : ''
    });

    jam.tandai('simpan & catat');

    /*
     * Tidak membaca ulang seluruh transaksi.
     *
     * Dari pengukuran, pembacaan ulang ini memakan 1,6 sampai 1,7
     * detik — dua pertiga dari seluruh waktu. Padahal layar Teknisi
     * sudah berubah sendiri sebelum jawaban ini sampai, karena
     * tombolnya berganti begitu ditekan.
     */
    jam.selesai();
    return { ringkas: true, trx_no: String(trx.trx_no) };
  });
}

// ============================================================
// API — SELESAI AKTIVASI
// ============================================================

function apiDoneActivation(payload) {
  return withGuard_(payload, { permission: 'ACTIVATION_DONE', lock: 'ringan' }, function (session) {
    var jam = Jam.mulai('apiDoneActivation');
    // Nomor revisi sengaja tidak diperiksa — lihat keterangan di atas
    var trx = loadTrxForTeknisi_(session, payload.trx_id, null);

    var tahapKini = String(trx.stage_status);

    /*
     * Sudah selesai sebelumnya — dijawab baik-baik, bukan dianggap salah.
     *
     * Penyimpanan berjalan di latar belakang, jadi jawaban bisa datang
     * terlambat atau terkirim dua kali. Yang kedua tidak perlu jadi
     * kotak merah kalau hasilnya sudah seperti yang diinginkan.
     */
    if (tahapKini === 'SELESAI' || tahapKini === 'AKTIVASI_SELESAI') {
      jam.selesai();
      return { ringkas: true, trx_no: String(trx.trx_no), sudah: true, durasi_menit: 0 };
    }

    var now = nowIso_();

    /*
     * Belum ditandai mulai — dianggap mulai dan selesai sekaligus.
     *
     * Ini kejadian nyata di lapangan: Teknisi menekan "Mulai aktivasi",
     * layarnya langsung berubah, lalu pekerjaannya cepat selesai dan
     * dia menekan "Aktivasi selesai" sebelum penyimpanan yang pertama
     * sampai ke server. Dari sisi server, aktivasi belum pernah
     * dimulai — padahal sudah, dan sudah selesai pula.
     *
     * Menolaknya membuat Teknisi melihat kotak merah untuk pekerjaan
     * yang justru berhasil dia kerjakan. Jadi waktu mulainya diisikan
     * di sini dan pekerjaannya diteruskan.
     */
    if (tahapKini === 'MENUNGGU_AKTIVASI') {
      if (!trx.activation_start_at) {
        trx.activation_start_at = now;
        Repo.tundaUpdate(DB.SHEET.TRX, trx._row, {
          activation_start_at: now, tech_user_id: session.user_id
        });
      }
    } else if (tahapKini !== 'PROSES_AKTIVASI') {
      throw appErr_('STAGE_LOCKED',
        'Transaksi ini tidak sedang di tahap aktivasi. Status sekarang: ' +
        stageLabel_(trx.stage_status) + '.');
    }

    var mulai = Util.isoStr(trx.activation_start_at);
    var menit = mulai
      ? Math.max(Math.round((new Date(now).getTime() - new Date(mulai).getTime()) / 60000), 0)
      : 0;

    /*
     * Pesanan yang dikerjakan sebelum bernota kembali ke Admin.
     *
     * Ada customer yang minta unitnya dirakit atau diaktivasi dulu,
     * lalu datang membayar belakangan. Pekerjaannya selesai, tapi
     * notanya belum terbit dan belum ada yang dibayar — jadi
     * barangnya belum boleh keluar.
     *
     * Dikembalikan ke Admin untuk nota, lalu Kasir seperti biasa.
     * Tanpa ini pesanan seperti itu langsung berstatus selesai dan
     * barangnya bisa diserahkan tanpa pernah melewati Kasir.
     */
    /*
     * Dikembalikan ke Eksekusi, bukan langsung ke Admin.
     *
     * Eksekusi yang memegang pesanan ini dari awal dan yang
     * mengirimnya ke Teknisi. Kalau hasilnya langsung mendarat di
     * Admin, Admin menerima pesanan yang tidak pernah dia lihat
     * sebelumnya dan harus menebak sudah sampai mana.
     *
     * Satu pintu: semua lewat Eksekusi. Dia yang memutuskan kapan
     * diteruskan ke Admin untuk nota.
     *
     * Kalau notanya ternyata sudah terbit — Admin membuatnya selagi
     * Teknisi bekerja — jalur biasa yang berlaku, dan pesanannya
     * lanjut seperti biasa tanpa mampir ke mana-mana.
     */
    var kembaliKeNota = Util.isTrue(trx.tek_dulu) &&
                        !String(trx.nota_no || '').trim();

    bumpRevision_(session, trx, kembaliKeNota
      ? {
          stage_status: 'PROSES_GUDANG',
          tech_user_id: session.user_id,
          activation_done_at: now,
          tek_dulu: false
        }
      : {
          stage_status: 'SELESAI',
          tech_user_id: session.user_id,
          activation_done_at: now,
          completed_at: now
        });

    if (kembaliKeNota) {
      pushNotif_({
        target_role: (String(trx.channel || '').toUpperCase() === 'ONLINE'
                      ? 'EKSEKUSI' : 'GUDANG'),
        target_branch: trx.branch,
        trx_id: trx.trx_id, trx_no: trx.trx_no,
        type: 'ORDER_READY', priority: 'HIGH',
        title: 'Selesai dikerjakan Teknisi',
        body: trx.trx_no + ' · ' + String(trx.cust_name_snap) +
          ' · notanya belum terbit, tinggal diteruskan ke Admin'
      });
    }

    logAudit_(session, {
      entity: 'TRX', entity_id: trx.trx_id, trx_no: trx.trx_no,
      action: 'STAGE_CHANGE', field: 'stage_status',
      old_value: 'PROSES_AKTIVASI', new_value: 'SELESAI'
    });
    logTimeline_(session, {
      trx_id: trx.trx_id, trx_no: trx.trx_no,
      event_code: 'ACTIVATION_DONE', stage_after: 'AKTIVASI_SELESAI',
      event_label: 'Teknisi ' + session.full_name + ' menyelesaikan aktivasi',
      detail: (menit ? 'lama pengerjaan ' + menit + ' menit' : '') +
        (payload.catatan ? ' · ' + String(payload.catatan).substring(0, 200) : '')
    });
    logTimeline_(session, {
      trx_id: trx.trx_id, trx_no: trx.trx_no,
      event_code: 'TRX_DONE', stage_after: 'SELESAI',
      event_label: 'Transaksi selesai',
      detail: ''
    });

    pushNotif_({
      target_role: 'SALES', target_branch: trx.branch,
      trx_id: trx.trx_id, trx_no: trx.trx_no,
      type: 'DONE', priority: 'NORMAL',
      title: 'Transaksi selesai',
      body: trx.trx_no + ' · ' + trx.cust_name_snap + ' · aktivasi selesai'
    });
    pushNotif_({
      target_role: 'ADMIN', target_branch: trx.branch,
      trx_id: trx.trx_id, trx_no: trx.trx_no,
      type: 'DONE', priority: 'NORMAL',
      title: 'Transaksi selesai',
      body: trx.trx_no + ' · ' + trx.cust_name_snap
    });

    return { trx_no: String(trx.trx_no), durasi_menit: menit, stage: 'SELESAI' };
  });
}

// ============================================================
// API — PANGGIL CUSTOMER
// ============================================================

function apiPanggilCustomer(payload) {
  return withGuard_(payload, { permission: 'CUSTOMER_CALL', lock: 'ringan' }, function (session) {
    var trx = Repo.findOne(DB.SHEET.TRX, 'trx_id', payload.trx_id);
    if (!trx) throw appErr_('NOT_FOUND', 'Transaksi tidak ditemukan.');

    var flags = {};
    try { flags = JSON.parse(String(trx.override_flags || '') || '{}'); } catch (e) {}

    var jeda = Settings.num('RECALL_COOLDOWN_SEC', 120);
    if (flags.panggil && flags.panggil.at) {
      var lewat = Math.round((new Date().getTime() - new Date(flags.panggil.at).getTime()) / 1000);
      if (lewat < jeda) {
        throw appErr_('COOLDOWN',
          'Customer baru saja dipanggil. Tunggu ' + (jeda - lewat) + ' detik lagi.');
      }
    }

    var jenis = String(payload.jenis || '').toUpperCase() === 'AMBIL' ? 'AMBIL' : 'AKTIVASI';

    var jumlah = (flags.panggil ? Number(flags.panggil.jumlah) || 0 : 0) + 1;
    flags.panggil = { at: nowIso_(), by: session.full_name, jumlah: jumlah, jenis: jenis };
    Repo.update(DB.SHEET.TRX, trx._row, { override_flags: JSON.stringify(flags) });

    var sapaan = String(Settings.get('CALL_GREETING', 'Atas nama'));
    var tujuan = jenis === 'AMBIL'
      ? String(Settings.get('CALL_DESTINATION_AMBIL',
          'barang Anda sudah siap, silakan menuju meja Teknisi Support'))
      : String(Settings.get('CALL_DESTINATION',
          'silakan menuju meja Teknisi Support'));
    var teks = sapaan + ' ' + trx.cust_name_snap + ', ' + tujuan + '.';

    logTimeline_(session, {
      trx_id: trx.trx_id, trx_no: trx.trx_no,
      event_code: jenis === 'AMBIL' ? 'CUSTOMER_CALL_AMBIL' : 'CUSTOMER_CALL',
      stage_after: String(trx.stage_status),
      event_label: session.full_name + ' memanggil customer' +
        (jenis === 'AMBIL' ? ' untuk mengambil barang' : '') +
        (jumlah > 1 ? ' (panggilan ke-' + jumlah + ')' : ''),
      detail: trx.cust_name_snap
    });

    return { teks: teks, jumlah: jumlah, jeda: jeda, jenis: jenis };
  });
}

// ============================================================
// API — BARANG SUDAH DISERAHKAN
//
// Aktivasi selesai belum berarti barangnya sudah di tangan customer.
// Sering kali customer duduk lagi di ruang tunggu dan perlu dipanggil
// sekali lagi. Penanda ini yang membedakan "selesai dikerjakan" dari
// "sudah diambil", dan berguna kalau suatu saat ada pertanyaan
// barangnya sudah diambil atau belum.
// ============================================================

function apiTandaiDiserahkan(payload) {
  return withGuard_(payload, { permission: 'ACTIVATION_DONE', lock: 'ringan' }, function (session) {
    var jam = Jam.mulai('apiTandaiDiserahkan');
    var trx = Repo.findOne(DB.SHEET.TRX, 'trx_id', payload.trx_id);
    if (!trx) throw appErr_('NOT_FOUND', 'Transaksi tidak ditemukan.');

    var stage = String(trx.stage_status);

    /*
     * Barang tidak boleh keluar sebelum dibayar.
     *
     * Pekerjaan Teknisi boleh berjalan duluan kalau pengaturannya
     * dinyalakan — tapi penyerahannya tetap menunggu uangnya masuk,
     * atau tempo yang sudah disetujui Kasir.
     *
     * Ini satu-satunya penjaga yang tersisa pada jalur itu, jadi
     * tidak boleh dilonggarkan.
     */
    var sudahBayar = String(trx.payment_status) === 'LUNAS' ||
                     !!Util.dateStr(trx.tempo_jatuh);

    if (!sudahBayar && !hasPerm_(session, 'GUARD_OVERRIDE')) {
      throw appErr_('BELUM_LUNAS',
        'Belum lunas, barangnya belum bisa diserahkan. Sisa ' +
        formatRp_(Number(trx.outstanding) || Number(trx.grand_total) || 0) +
        '. Arahkan customer ke Kasir dulu.');
    }

    /*
     * Aktivasi yang belum tercatat selesai ikut dituntaskan di sini.
     *
     * Alasannya sama dengan di apiDoneActivation: penyimpanan berjalan
     * di latar belakang, jadi urutan sampainya bisa terbalik. Teknisi
     * yang sudah menekan Selesai lalu Serahkan tidak boleh dihentikan
     * hanya karena yang pertama belum sempat tersimpan.
     *
     * Yang tetap ditolak: transaksi yang memang belum sampai ke meja
     * Teknisi.
     */
    if (['SELESAI', 'AKTIVASI_SELESAI'].indexOf(stage) < 0) {
      if (['MENUNGGU_AKTIVASI', 'PROSES_AKTIVASI'].indexOf(stage) < 0) {
        throw appErr_('STAGE_LOCKED',
          'Transaksi ini belum sampai tahap aktivasi. Status sekarang: ' +
          stageLabel_(stage) + '.');
      }

      var skr = nowIso_();
      Repo.tundaUpdate(DB.SHEET.TRX, trx._row, {
        stage_status: 'SELESAI',
        tech_user_id: session.user_id,
        activation_start_at: trx.activation_start_at || skr,
        activation_done_at: trx.activation_done_at || skr,
        completed_at: skr
      });
      trx.stage_status = 'SELESAI';

      logTimeline_(session, {
        trx_id: trx.trx_id, trx_no: trx.trx_no,
        event_code: 'ACT_DONE', stage_after: 'SELESAI',
        event_label: 'Aktivasi ditandai selesai bersamaan dengan penyerahan',
        detail: 'Dicatat menyusul oleh ' + session.full_name
      });
    }

    var flags = {};
    try { flags = JSON.parse(String(trx.override_flags || '') || '{}'); } catch (e) {}

    if (flags.diserahkan && flags.diserahkan.at) {
      return dataTeknisi_(session, trx.trx_id);
    }

    flags.diserahkan = {
      at: nowIso_(), by: session.full_name, user_id: session.user_id,
      note: String(payload.catatan || '').trim()
    };
    Repo.update(DB.SHEET.TRX, trx._row, { override_flags: JSON.stringify(flags) });

    /*
     * Permintaan ganti unit yang masih terbuka ikut ditutup.
     *
     * Kalau barangnya sudah keluar ke customer, tidak mungkin masih ada
     * unit pengganti yang ditunggu. Tanpa ini, permintaannya berdiri
     * terus di daftar Gudang seolah masih ada pekerjaan — dan yang
     * melihatnya tidak tahu itu sebenarnya sudah selesai.
     */
    var gantiTutup = 0;
    try {
      trx.override_flags = JSON.stringify(flags);
      gantiTutup = tutupGantiOtomatis_(session, trx);
    } catch (eG) {}

    logAudit_(session, {
      entity: 'TRX', entity_id: trx.trx_id, trx_no: trx.trx_no,
      action: 'UPDATE', field: 'diserahkan',
      old_value: 'belum', new_value: 'sudah diserahkan' +
        (gantiTutup ? ' · ' + gantiTutup + ' permintaan ganti ikut ditutup' : ''),
      reason: payload.catatan || ''
    });
    logTimeline_(session, {
      trx_id: trx.trx_id, trx_no: trx.trx_no,
      event_code: 'BARANG_DISERAHKAN', stage_after: stage,
      event_label: session.full_name + ' menyerahkan barang ke customer',
      detail: String(payload.catatan || '')
    });

    jam.tandai('simpan & catat');

    /*
     * Tidak membaca ulang seluruh transaksi.
     *
     * Dari pengukuran, pembacaan ulang ini memakan 1,6 sampai 1,7
     * detik — dua pertiga dari seluruh waktu. Padahal layar Teknisi
     * sudah berubah sendiri sebelum jawaban ini sampai, karena
     * tombolnya berganti begitu ditekan.
     */
    jam.selesai();
    return { ringkas: true, trx_no: String(trx.trx_no) };
  });
}

// ============================================================
// API — RIWAYAT AKTIVASI
// ============================================================

function apiTeknisiRiwayat(payload) {
  return withGuard_(payload, { permission: 'ACTIVATION_START' }, function (session) {
    var hari = Number(payload.hari === undefined ? 7 : payload.hari);
    var q = String(payload.q || '').trim().toUpperCase();
    var semuaCabang = hasPerm_(session, 'TRX_VIEW_ALL');

    var batas = new Date();
    batas.setDate(batas.getDate() - hari);
    var batasMs = batas.getTime();

    var rows = Repo.columns(DB.SHEET.TRX, [
      'trx_id', 'trx_no', 'branch', 'cust_name_snap', 'sales_name', 'nota_no',
      'activation_start_at', 'activation_done_at', 'tech_user_id',
      'item_count', 'payment_status', 'is_void'
    ]);

    var nama = {};
    Repo.columns(DB.SHEET.USERS, ['user_id', 'full_name']).forEach(function (u) {
      nama[String(u.user_id)] = String(u.full_name);
    });

    var out = [], totalMenit = 0;

    for (var i = 0; i < rows.length; i++) {
      var t = rows[i];
      if (Util.isTrue(t.is_void)) continue;
      if (!t.activation_done_at) continue;
      if (!semuaCabang && String(t.branch) !== String(session.branch)) continue;

      var selesai = new Date(Util.isoStr(t.activation_done_at)).getTime();
      if (hari > 0 && selesai < batasMs) continue;

      if (q) {
        var bahan = [t.trx_no, t.cust_name_snap, t.nota_no, t.sales_name].join(' ').toUpperCase();
        if (bahan.indexOf(q) < 0) continue;
      }

      var mulai = t.activation_start_at
        ? new Date(Util.isoStr(t.activation_start_at)).getTime() : selesai;
      var menit = Math.max(Math.round((selesai - mulai) / 60000), 0);
      totalMenit += menit;

      out.push({
        trx_id: String(t.trx_id), trx_no: String(t.trx_no),
        nota_no: String(t.nota_no || ''),
        cust_name: String(t.cust_name_snap), sales_name: String(t.sales_name || ''),
        item_count: Number(t.item_count) || 0,
        payment_status: String(t.payment_status),
        start_at: Util.isoStr(t.activation_start_at),
        done_at: Util.isoStr(t.activation_done_at),
        durasi_menit: menit,
        teknisi: nama[String(t.tech_user_id)] || String(t.tech_user_id || '')
      });
    }

    out.sort(function (a, b) { return a.done_at < b.done_at ? 1 : -1; });

    return {
      list: out.slice(0, 150), total: out.length,
      rataMenit: out.length ? Math.round(totalMenit / out.length) : 0
    };
  });
}

// ============================================================
// PENGATURAN PEMANGGILAN — jalankan sekali dari editor
// ============================================================

function siapkanPengaturanPanggil() {
  var sh = Repo.sheet(DB.SHEET.SETTINGS);
  var ada = {};
  Repo.columns(DB.SHEET.SETTINGS, ['key']).forEach(function (r) { ada[String(r.key).trim()] = true; });

  var now = nowIso_();
  var baru = [
    ['CALL_GREETING', 'Atas nama', 'TEXT', 'TEKNISI',
     'Kata pembuka saat memanggil customer. Hasilnya: "Atas nama Kak Anditia, silakan menuju meja Teknisi Support."'],
    ['CALL_DESTINATION', 'silakan menuju meja Teknisi Support', 'TEXT', 'TEKNISI',
     'Kalimat penutup saat memanggil customer untuk memulai aktivasi.'],
    ['CALL_DESTINATION_AMBIL', 'barang Anda sudah siap, silakan menuju meja Teknisi Support', 'TEXT', 'TEKNISI',
     'Kalimat penutup saat memanggil customer untuk mengambil barang setelah aktivasi selesai.'],
    ['CALL_VOICE_RATE', '0.92', 'NUMBER', 'TEKNISI',
     'Kecepatan suara pemanggilan. 1 = normal, di bawah 1 lebih lambat dan lebih jelas terdengar.']
  ].filter(function (s) { return !ada[s[0]]; });

  if (baru.length) {
    sh.getRange(sh.getLastRow() + 1, 1, baru.length, 7).setValues(
      baru.map(function (s) { return [s[0], s[1], s[2], s[3], s[4], now, 'SETUP']; }));
  }
  Settings.bust();

  return kabar_((baru.length ? baru.length + ' pengaturan pemanggilan ditambahkan.' : 'Pengaturan sudah ada.') +
    '\n\nSuara dibacakan oleh komputer tempat aplikasi dibuka. Supaya terdengar ' +
    'sampai ruang tunggu, sambungkan komputer teknisi ke speaker toko.');
}

function apiSettingPanggil(payload) {
  return withGuard_(payload, { permission: 'CUSTOMER_CALL' }, function () {
    return {
      greeting: String(Settings.get('CALL_GREETING', 'Atas nama')),
      destination: String(Settings.get('CALL_DESTINATION', 'silakan menuju meja Teknisi Support')),
      destinationAmbil: String(Settings.get('CALL_DESTINATION_AMBIL',
        'barang Anda sudah siap, silakan menuju meja Teknisi Support')),
      rate: Settings.num('CALL_VOICE_RATE', 0.92),
      jeda: Settings.num('RECALL_COOLDOWN_SEC', 120)
    };
  });
}

// ============================================================
// PANTAUAN RINGKAS UNTUK TEKNISI
//
// Kejadian di lapangan: customer dan barangnya sudah sampai meja
// Teknisi, tapi transaksinya tidak muncul di antrian karena masih
// tertahan di Kasir. Teknisi tidak punya cara melihat itu, jadi yang
// terjadi adalah menunggu tanpa tahu apa yang ditunggu.
//
// Ini bukan monitoring penuh seperti milik Admin — hanya daftar
// transaksi yang masih berjalan beserta divisi yang sedang
// memegangnya, supaya Teknisi bisa langsung mengabari yang tepat.
// ============================================================

function apiPantauAlur(payload) {
  return withGuard_(payload, { permission: 'TRX_VIEW_STAGE' }, function (session) {
    var q = String(payload.q || '').trim().toUpperCase();
    var semuaCabang = hasPerm_(session, 'TRX_VIEW_ALL');
    var sekarang = new Date().getTime();

    var rows = Repo.columns(DB.SHEET.TRX, [
      'trx_id', 'trx_no', 'branch', 'trx_date', 'cust_name_snap',
      'sales_name', 'stage_status', 'payment_status', 'nota_no', 'nota_indent',
      'channel', 'item_count', 'sales_confirm_at', 'gudang_confirm_at', 'updated_at', 'is_void'
    ]);

    /*
     * Dengan "semua", yang sudah tuntas ikut ditampilkan.
     *
     * Teknisi perlu bisa menengok ke belakang — memastikan transaksi
     * tiga hari lalu memang sudah diserahkan, atau mencari unit yang
     * pernah ditangani. Tanpa itu, satu-satunya cara adalah bertanya
     * ke Admin.
     */
    var ikutSelesai = Util.isTrue(payload.semua) || !!q;

    var pemegang = {
      SELESAI: 'Selesai — sudah diserahkan',
      AKTIVASI_SELESAI: 'Selesai — menunggu diambil',
      DIBATALKAN: 'Dibatalkan',
      MENUNGGU_BARANG: 'Sales — menunggu barang datang',
      MENUNGGU_GUDANG: 'Gudang — belum mulai disiapkan',
      PROSES_GUDANG: 'Gudang — sedang disiapkan',
      SIAP_NOTA: 'Admin — menunggu nomor nota',
      MENUNGGU_PEMBAYARAN: 'Kasir — menunggu pembayaran',
      MENUNGGU_AKTIVASI: 'Teknisi — menunggu dikerjakan',
      PROSES_AKTIVASI: 'Teknisi — sedang dikerjakan'
    };

    var out = [];
    var rekap = {};

    rows.forEach(function (t) {
      if (Util.isTrue(t.is_void)) return;
      var tahap = String(t.stage_status);
      if (!pemegang[tahap]) return;                 // draft
      if (!ikutSelesai &&
          (tahap === 'SELESAI' || tahap === 'AKTIVASI_SELESAI' ||
           tahap === 'DIBATALKAN')) return;
      if (!semuaCabang && String(t.branch) !== String(session.branch)) return;

      /*
       * Eksekusi hanya memantau pesanan online.
       *
       * Yang dia butuhkan: pesanannya sendiri sedang di divisi mana.
       * Mencampurnya dengan ritel membuat daftarnya panjang oleh
       * pekerjaan yang bukan urusannya.
       */
      var chP = String(t.channel || 'RITEL').toUpperCase();
      if (String(session.role) === 'EKSEKUSI' && chP !== 'ONLINE') return;
      if (String(session.role) === 'GUDANG' && chP === 'ONLINE') return;

      if (q) {
        var bahan = [t.trx_no, t.cust_name_snap, t.nota_no, t.sales_name]
                      .join(' ').toUpperCase();
        if (bahan.indexOf(q) < 0) return;
      }

      var sejak = t.updated_at ? new Date(Util.isoStr(t.updated_at)).getTime() : sekarang;
      var menit = Math.max(Math.round((sekarang - sejak) / 60000), 0);

      rekap[tahap] = (rekap[tahap] || 0) + 1;

      out.push({
        trx_id: String(t.trx_id), trx_no: String(t.trx_no),
        trx_date: Util.dateStr(t.trx_date),
        cust_name: String(t.cust_name_snap),
        sales_name: String(t.sales_name || ''),
        stage_status: tahap,
        stage_label: stageLabelCh_(tahap, t.channel),
        pemegang: (String(t.channel || '').toUpperCase() === 'ONLINE' &&
                   (tahap === 'MENUNGGU_GUDANG' || tahap === 'PROSES_GUDANG'))
          ? pemegang[tahap].replace('Gudang', 'Eksekusi')
          : pemegang[tahap],
        payment_status: String(t.payment_status),
        nota_no: String(t.nota_no || t.nota_indent || ''),
        item_count: Number(t.item_count) || 0,
        selesai: tahap === 'SELESAI' || tahap === 'DIBATALKAN',
        menit: menit
      });
    });

    // Yang paling lama tertahan di atas — itu yang paling perlu ditanyakan
    out.sort(function (a, b) { return b.menit - a.menit; });

    return {
      list: out.slice(0, 80), total: out.length,
      rekap: {
        gudang: (rekap.MENUNGGU_GUDANG || 0) + (rekap.PROSES_GUDANG || 0),
        admin: rekap.SIAP_NOTA || 0,
        kasir: rekap.MENUNGGU_PEMBAYARAN || 0,
        teknisi: (rekap.MENUNGGU_AKTIVASI || 0) + (rekap.PROSES_AKTIVASI || 0),
        indent: rekap.MENUNGGU_BARANG || 0
      }
    };
  });
}

// ============================================================
// RIWAYAT AKTIVASI UNTUK LAYAR TEKNISI
//
// Berbeda dari apiTeknisiRiwayat yang sudah ada — yang itu dipakai
// laporan kecepatan dan hanya memuat yang sudah selesai aktivasi.
//
// Yang ini untuk Teknisi menengok ke belakang: apa saja yang pernah
// masuk mejanya, sudah diserahkan atau belum, dan apakah ada
// permintaan ganti yang tertinggal tanpa ditutup.
// ============================================================

function apiRiwayatAktivasi(payload) {
  return withGuard_(payload, { permission: 'TRX_VIEW_STAGE' }, function (session) {
    var hari = Number(payload.hari === undefined ? 7 : payload.hari);
    var q = String(payload.q || '').trim().toUpperCase();
    var semuaCabang = hasPerm_(session, 'TRX_VIEW_ALL');

    var batas = new Date();
    batas.setDate(batas.getDate() - (hari > 0 ? hari - 1 : 0));
    var batasStr = Utilities.formatDate(batas, 'Asia/Jakarta', 'yyyy-MM-dd');

    var rows = Repo.columns(DB.SHEET.TRX, [
      'trx_id', 'trx_no', 'branch', 'trx_date', 'cust_name_snap', 'cust_phone_snap',
      'sales_name', 'stage_status', 'item_count', 'nota_no', 'tech_petugas_nama',
      'activation_start_at', 'activation_done_at', 'override_flags', 'is_void'
    ]);

    var out = [];

    rows.forEach(function (t) {
      if (Util.isTrue(t.is_void)) return;
      if (!semuaCabang && String(t.branch) !== String(session.branch)) return;

      // Yang pernah masuk meja Teknisi saja
      if (!t.activation_start_at && !t.activation_done_at) return;

      var tgl = Util.dateStr(t.activation_done_at || t.activation_start_at || t.trx_date);

      var f = {};
      try { f = JSON.parse(String(t.override_flags || '') || '{}'); } catch (e) {}
      var diserahkan = !!(f.diserahkan && f.diserahkan.at);

      /*
       * Yang belum diserahkan selalu ikut, berapa pun umurnya.
       *
       * Kalau disaring per tanggal, unit yang terlewat ditandai
       * kemarin menghilang dari layar hari ini — dan tidak ada lagi
       * yang mengingatkan bahwa barangnya masih menggantung.
       */
      if (!q && diserahkan && tgl < batasStr) return;

      if (q) {
        var bahan = [t.trx_no, t.cust_name_snap, t.sales_name, t.nota_no]
                      .join(' ').toUpperCase();
        if (bahan.indexOf(q) < 0) return;
      }

      var gantiTerbuka = 0, gantiTotal = 0;
      if (f.ganti && f.ganti.length) {
        f.ganti.forEach(function (g) {
          gantiTotal++;
          if (['SELESAI', 'BATAL'].indexOf(String(g.status)) < 0) gantiTerbuka++;
        });
      }

      var mulai = t.activation_start_at
        ? new Date(Util.isoStr(t.activation_start_at)).getTime() : 0;
      var selesai = t.activation_done_at
        ? new Date(Util.isoStr(t.activation_done_at)).getTime() : 0;

      out.push({
        trx_id: String(t.trx_id), trx_no: String(t.trx_no),
        tanggal: tgl,
        cust_name: String(t.cust_name_snap), cust_phone: Util.hp(t.cust_phone_snap),
        sales_name: String(t.sales_name || ''), nota_no: String(t.nota_no || ''),
        tech_nama: String(t.tech_petugas_nama || ''),
        item_count: Number(t.item_count) || 0,
        stage_label: stageLabel_(t.stage_status),
        mulai_at: Util.isoStr(t.activation_start_at),
        selesai_at: Util.isoStr(t.activation_done_at),
        durasi_menit: (mulai && selesai) ? Math.max(Math.round((selesai - mulai) / 60000), 0) : 0,
        diserahkan: diserahkan,
        diserahkan_at: diserahkan ? String(f.diserahkan.at) : '',
        diserahkan_by: diserahkan ? String(f.diserahkan.by || '') : '',
        ganti_terbuka: gantiTerbuka, ganti_total: gantiTotal
      });
    });

    out.sort(function (a, b) {
      // Yang belum diserahkan didahulukan — itu yang perlu ditindak
      if (a.diserahkan !== b.diserahkan) return a.diserahkan ? 1 : -1;
      var x = a.selesai_at || a.mulai_at, y = b.selesai_at || b.mulai_at;
      return x < y ? 1 : -1;
    });

    return {
      list: out.slice(0, 150), total: out.length,
      belumDiserahkan: out.filter(function (r) { return !r.diserahkan; }).length,
      gantiGantung: out.filter(function (r) { return r.ganti_terbuka > 0; }).length
    };
  });
}
