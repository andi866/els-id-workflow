/**
 * ELS.ID WORKFLOW SYSTEM — v2 (percepatan)
 * File : 04_CustomerService.gs
 *
 * Perubahan dari v1:
 * - Pencarian memakai indeks ringkas yang disimpan di cache 10 menit,
 *   bukan membaca ulang seluruh sheet tiap ketikan.
 * - Nomor HP dicocokkan dalam bentuk inti, jadi 0877…, +62877…, 62877…,
 *   dan 877… sama-sama ketemu.
 * - Indeks dibuang otomatis setiap ada customer baru atau diubah.
 */

var CUST_IDX_KEY = 'ELS_CUSTIDX_V1';

function getCustomerIndex_() {
  /*
   * Customer baru dari formulir QR harus langsung terlihat.
   *
   * Formulir QR adalah project terpisah — dia menulis langsung ke
   * sheet CUSTOMERS tanpa lewat aplikasi ini, jadi salinan di sini
   * tidak tahu ada baris baru dan tetap dipakai sampai sepuluh menit.
   * Akibatnya customer yang barusan mengisi formulir tidak ketemu
   * saat Sales mencarinya — padahal orangnya berdiri di depan meja.
   *
   * Jumlah baris sheet diperiksa dulu. Itu satu perjalanan yang
   * sangat ringan, jauh lebih murah daripada membangun ulang seluruh
   * daftar, dan cukup untuk tahu ada tambahan atau tidak.
   */
  var barisKini = 0;
  try { barisKini = Repo.sheet(DB.SHEET.CUSTOMERS).getLastRow(); } catch (e) {}

  var hit = cacheGetBig_(CUST_IDX_KEY);
  if (hit) {
    try {
      var simpan = JSON.parse(hit);
      if (simpan && simpan.baris === barisKini && simpan.isi) return simpan.isi;
    } catch (e) {}
  }

  var rows = Repo.columns(DB.SHEET.CUSTOMERS,
    ['customer_id', 'full_name', 'phone', 'phone_norm', 'member_code',
     'email', 'address', 'trx_count', 'is_active']);

  var idx = [];
  for (var i = 0; i < rows.length; i++) {
    var c = rows[i];
    if (!Util.isTrue(c.is_active)) continue;
    idx.push({
      i: String(c.customer_id),
      n: String(c.full_name),
      p: Util.hp(c.phone),
      h: Util.coreHp(c.phone_norm || c.phone),
      m: String(c.member_code || ''),
      e: String(c.email || ''),
      a: String(c.address || ''),
      c: Number(c.trx_count) || 0,
      s: String(c.full_name).toLowerCase()
    });
  }

  cacheSetBig_(CUST_IDX_KEY, JSON.stringify({ baris: barisKini, isi: idx }), 600);
  return idx;
}

function bustCustomerCache_() { cacheDelBig_(CUST_IDX_KEY); }

// ============================================================
// API
// ============================================================

function apiSearchCustomer(payload) {
  return withGuard_(payload, { permission: 'CUSTOMER_VIEW_BASIC' }, function (session) {
    var q = String(payload.q || '').trim().toLowerCase();
    if (q.length < 2) return [];

    var qHp = Util.coreHp(q);
    var pakaiHp = qHp.length >= 3 && /[0-9]/.test(q);
    var idx = getCustomerIndex_();
    var out = [];

    for (var i = 0; i < idx.length && out.length < 20; i++) {
      var c = idx[i];
      var cocok =
        c.s.indexOf(q) >= 0 ||
        (c.m && c.m.toLowerCase().indexOf(q) >= 0) ||
        (pakaiHp && c.h.indexOf(qHp) >= 0);
      if (cocok) out.push({
        customer_id: c.i, full_name: c.n, phone: c.p,
        email: c.e, address: c.a,
        member_code: c.m, trx_count: c.c
      });
    }

    // Customer yang baru saja mengisi form QR belum tentu masuk indeks,
    // karena indeksnya disimpan sementara. Kalau tidak ketemu, baris
    // terbaru dibaca langsung supaya Sales tidak perlu menunggu.
    if (!out.length) {
      var tambahan = cariCustomerTerbaru_(q, qHp, pakaiHp, idx.length);
      if (tambahan.length) out = tambahan;
    }

    return out;
  });
}

/** Detail lengkap satu customer — dipanggil hanya saat benar-benar perlu */
function apiGetCustomer(payload) {
  return withGuard_(payload, { permission: 'CUSTOMER_VIEW' }, function () {
    var c = Repo.findOne(DB.SHEET.CUSTOMERS, 'customer_id', payload.customer_id);
    if (!c) throw appErr_('NOT_FOUND', 'Customer tidak ditemukan.');
    return {
      customer_id: String(c.customer_id), full_name: String(c.full_name),
      phone: Util.hp(c.phone), email: String(c.email || ''),
      address: String(c.address || ''), member_code: String(c.member_code || ''),
      trx_count: Number(c.trx_count) || 0,
      last_trx_at: Util.isoStr(c.last_trx_at),
      created_at: Util.isoStr(c.created_at),
      notes: String(c.notes || ''), source: String(c.source || '')
    };
  });
}

function apiCreateCustomer(payload) {
  return withGuard_(payload, { permission: 'CUSTOMER_CREATE', lock: true }, function (session) {
    var d = payload.data || {};
    var name = String(d.full_name || '').trim();
    var phone = String(d.phone || '').trim();

    if (name.length < 2) throw appErr_('BAD_NAME', 'Nama customer wajib diisi.');
    var norm = Util.normPhone(phone);
    if (norm.length < 10) throw appErr_('BAD_PHONE', 'Nomor WhatsApp belum benar. Contoh: 081234567890.');

    // Nomor WA sama = orang yang sama. Perbarui datanya, jangan bikin kembar.
    var dup = Repo.findOne(DB.SHEET.CUSTOMERS, 'phone_norm', norm);
    if (dup) {
      var patch = {}, changed = [];
      [['full_name', name], ['email', d.email], ['address', d.address], ['member_code', d.member_code]]
        .forEach(function (p) {
          var val = String(p[1] === undefined ? '' : p[1]).trim();
          if (val && val !== String(dup[p[0]]).trim()) { patch[p[0]] = val; changed.push(p[0]); }
        });

      if (changed.length) {
        patch.updated_at = nowIso_();
        patch.updated_by = session.user_id;
        Repo.update(DB.SHEET.CUSTOMERS, dup._row, patch);
        changed.forEach(function (f) {
          logAudit_(session, {
            entity: 'CUSTOMER', entity_id: dup.customer_id, action: 'UPDATE',
            field: f, old_value: dup[f], new_value: patch[f],
            reason: 'Nomor WA sudah terdaftar, data diperbarui'
          });
        });
        bustCustomerCache_();
      }

      return {
        customer_id: String(dup.customer_id),
        full_name: String(patch.full_name || dup.full_name),
        phone: String(dup.phone),
        member_code: String(patch.member_code || dup.member_code || ''),
        email: String(patch.email || dup.email || ''),
        address: String(patch.address || dup.address || ''),
        merged: true
      };
    }

    var id = 'CUS-' + Util.todayStr().replace(/-/g, '') + '-' +
             Util.pad(countCustomerToday_() + 1, 4);
    var now = nowIso_();

    Repo.append(DB.SHEET.CUSTOMERS, {
      customer_id: id, full_name: name, phone: phone, phone_norm: norm,
      email: String(d.email || '').trim(), address: String(d.address || '').trim(),
      member_code: String(d.member_code || '').trim(),
      source: d.source || 'SALES_INPUT', branch: session.branch,
      created_at: now, created_by: session.user_id,
      updated_at: now, updated_by: session.user_id,
      trx_count: 0, last_trx_at: '', notes: '', is_active: true
    });

    bustCustomerCache_();
    logAudit_(session, {
      entity: 'CUSTOMER', entity_id: id, action: 'CREATE',
      new_value: name + ' / ' + phone
    });

    return {
      customer_id: id, full_name: name, phone: phone,
      member_code: String(d.member_code || ''), email: String(d.email || ''),
      address: String(d.address || ''), merged: false
    };
  });
}

function apiUpdateCustomer(payload) {
  return withGuard_(payload, { permission: 'CUSTOMER_EDIT', lock: true }, function (session) {
    var d = payload.data || {};
    var c = Repo.findOne(DB.SHEET.CUSTOMERS, 'customer_id', d.customer_id);
    if (!c) throw appErr_('NOT_FOUND', 'Customer tidak ditemukan.');

    var patch = {}, changed = [];
    ['full_name', 'email', 'address', 'member_code', 'notes'].forEach(function (f) {
      if (d[f] !== undefined && String(d[f]).trim() !== String(c[f]).trim()) {
        patch[f] = String(d[f]).trim(); changed.push(f);
      }
    });

    if (d.phone !== undefined) {
      var norm = Util.normPhone(d.phone);
      if (norm.length < 10) throw appErr_('BAD_PHONE', 'Nomor WhatsApp belum benar.');
      if (norm !== String(c.phone_norm)) {
        var other = Repo.findOne(DB.SHEET.CUSTOMERS, 'phone_norm', norm);
        if (other && other.customer_id !== c.customer_id) {
          throw appErr_('DUP_PHONE', 'Nomor itu sudah dipakai customer lain: ' + other.full_name + '.');
        }
        patch.phone = String(d.phone).trim();
        patch.phone_norm = norm;
        changed.push('phone');
      }
    }

    if (!changed.length) return { changed: 0 };

    patch.updated_at = nowIso_();
    patch.updated_by = session.user_id;
    Repo.update(DB.SHEET.CUSTOMERS, c._row, patch);
    bustCustomerCache_();

    changed.forEach(function (f) {
      logAudit_(session, {
        entity: 'CUSTOMER', entity_id: c.customer_id, action: 'UPDATE',
        field: f, old_value: c[f], new_value: patch[f]
      });
    });
    return { changed: changed.length };
  });
}

function apiRecentCustomers(payload) {
  return withGuard_(payload, { permission: 'CUSTOMER_VIEW_BASIC' }, function () {
    var idx = getCustomerIndex_();
    return idx.slice(-40).reverse().map(function (c) {
      return {
        customer_id: c.i, full_name: c.n, phone: c.p,
        email: c.e, address: c.a,
        member_code: c.m, trx_count: c.c,
        email: c.e || '', address: c.a || ''
      };
    });
  });
}

/**
 * Membaca 60 baris terakhir sheet customer secara langsung.
 * Dipakai hanya kalau pencarian di indeks tidak menemukan apa pun,
 * jadi tidak menambah beban pada pencarian yang biasa.
 */
function cariCustomerTerbaru_(q, qHp, pakaiHp, jumlahIndeks) {
  try {
    var sh = Repo.sheet(DB.SHEET.CUSTOMERS);
    var lr = sh.getLastRow();
    if (lr < 2) return [];

    var mulai = Math.max(lr - 59, 2);
    var h = Repo.headers(DB.SHEET.CUSTOMERS);
    var vals = sh.getRange(mulai, 1, lr - mulai + 1, h.length).getValues();

    var iId = h.indexOf('customer_id'), iNama = h.indexOf('full_name');
    var iHp = h.indexOf('phone'), iNorm = h.indexOf('phone_norm');
    var iMem = h.indexOf('member_code'), iAktif = h.indexOf('is_active');
    var iTrx = h.indexOf('trx_count');
    var iEmail = h.indexOf('email'), iAlamat = h.indexOf('address');

    var out = [];
    for (var i = vals.length - 1; i >= 0 && out.length < 20; i--) {
      var r = vals[i];
      if (!String(r[iId]).trim()) continue;
      if (iAktif >= 0 && r[iAktif] !== '' && !Util.isTrue(r[iAktif])) continue;

      var nama = String(r[iNama] || '').toLowerCase();
      var inti = Util.coreHp(r[iNorm] || r[iHp]);
      var mem = String(r[iMem] || '').toLowerCase();

      if (nama.indexOf(q) >= 0 || (mem && mem.indexOf(q) >= 0) ||
          (pakaiHp && inti.indexOf(qHp) >= 0)) {
        out.push({
          customer_id: String(r[iId]), full_name: String(r[iNama]),
          phone: String(r[iHp]), member_code: String(r[iMem] || ''),
          email: iEmail >= 0 ? String(r[iEmail] || '') : '',
          address: iAlamat >= 0 ? String(r[iAlamat] || '') : '',
          trx_count: Number(r[iTrx]) || 0, baru: true
        });
      }
    }

    // Kalau ada yang ketemu di sini tapi tidak di indeks, indeksnya
    // memang sudah basi — dibuang supaya pencarian berikutnya benar
    if (out.length) bustCustomerCache_();

    return out;
  } catch (e) {
    return [];
  }
}

// ============================================================
// BANTU
// ============================================================

function countCustomerToday_() {
  var today = Util.todayStr();
  var rows = Repo.columns(DB.SHEET.CUSTOMERS, ['customer_id', 'created_at']);
  var n = 0;
  for (var i = 0; i < rows.length; i++) {
    if (Util.dateStr(rows[i].created_at) === today) n++;
  }
  return n;
}
