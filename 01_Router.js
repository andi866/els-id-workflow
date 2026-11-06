/**
 * ELS.ID WORKFLOW SYSTEM — Phase 1
 * File : 01_Router.gs
 * Isi  : Pintu masuk web app + semua fungsi yang boleh dipanggil browser.
 *
 * ATURAN: setiap fungsi api* WAJIB lewat withGuard_ (kecuali login &
 * bootstrap, yang memang belum punya sesi). Jangan pernah menulis ke
 * spreadsheet langsung dari file ini.
 */

// ============================================================
// HALAMAN
// ============================================================

function doGet(e) {
  var t = HtmlService.createTemplateFromFile('App');
  t.appVersion = String(getSetting_('APP_VERSION') || '0.2');
  t.companyName = String(getSetting_('COMPANY_NAME') || 'ELS.ID');
  t.brandColor = String(getSetting_('BRAND_COLOR') || '#0B5FFF');

  return t.evaluate()
    .setTitle('ELS.ID Workflow')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, maximum-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Dipakai App.html untuk menyisipkan file HTML lain */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

// ============================================================
// API — TANPA SESI
// ============================================================

/** Dipanggil sekali saat halaman dibuka, untuk tahu sudah login atau belum */
function apiBootstrap(payload) {
  try {
    var out = {
      company: String(getSetting_('COMPANY_NAME') || 'ELS.ID'),
      brandColor: String(getSetting_('BRAND_COLOR') || '#0B5FFF'),
      version: String(getSetting_('APP_VERSION') || '0.2'),
      session: null
    };
    var token = payload && payload.token;
    if (token) {
      var s = readSession_(token);
      if (s) out.session = publicSession_(s);
    }
    return ok_(out);
  } catch (e) {
    return err_('BOOTSTRAP_FAIL', e.message);
  }
}

function apiLogin(payload) {
  try {
    return ok_(login_(
      String(payload.username || '').trim().toLowerCase(),
      String(payload.pin || '').trim(),
      String(payload.device || '').substring(0, 120)
    ));
  } catch (e) {
    return err_(e.code || 'LOGIN_FAIL', e.message);
  }
}

// ============================================================
// API — PERLU SESI
// ============================================================

function apiLogout(payload) {
  return withGuard_(payload, { allowPinChange: true }, function (session) {
    revokeSession_(session.token);
    logAudit_(session, { entity: 'USER', entity_id: session.user_id, action: 'LOGOUT' });
    return { done: true };
  });
}

/** Dipanggil berkala agar sesi tidak dianggap mati + tempat notifikasi nanti */
function apiPing(payload) {
  return withGuard_(payload, {}, function (session) {
    touchSession_(session.token);
    return { serverTime: nowIso_(), user: session.full_name };
  });
}

function apiChangePin(payload) {
  return withGuard_(payload, { allowPinChange: true, lock: true }, function (session) {
    var oldPin = String(payload.oldPin || '').trim();
    var newPin = String(payload.newPin || '').trim();

    if (!/^\d{6}$/.test(newPin)) throw appErr_('BAD_PIN', 'PIN baru harus 6 digit angka.');
    if (newPin === '123456' || /^(\d)\1{5}$/.test(newPin)) {
      throw appErr_('WEAK_PIN', 'PIN terlalu mudah ditebak. Gunakan kombinasi lain.');
    }

    var u = Repo.findOne(DB.SHEET.USERS, 'user_id', session.user_id);
    if (!u) throw appErr_('NOT_FOUND', 'Akun tidak ditemukan.');
    if (hashPin_(u.pin_salt, oldPin) !== String(u.pin_hash)) {
      throw appErr_('WRONG_PIN', 'PIN lama salah.');
    }
    if (oldPin === newPin) throw appErr_('SAME_PIN', 'PIN baru harus berbeda dari PIN lama.');

    var salt = randomSalt_();
    Repo.update(DB.SHEET.USERS, u._row, {
      pin_salt: salt,
      pin_hash: hashPin_(salt, newPin),
      must_change_pin: false,
      updated_at: nowIso_(),
      updated_by: session.user_id
    });

    clearSessionCache_(session.token);
    logAudit_(session, {
      entity: 'USER', entity_id: session.user_id,
      action: 'UPDATE', field: 'pin', old_value: '(rahasia)', new_value: '(rahasia)'
    });
    return { done: true };
  });
}

function apiMyMenu(payload) {
  return withGuard_(payload, {}, function (session) {
    return { role: session.role, permissions: permissionsOf_(session.role) };
  });
}

// ============================================================
// API — KELOLA USER (SUPER ADMIN)
// ============================================================

function apiListUsers(payload) {
  return withGuard_(payload, { permission: 'USER_MANAGE' }, function () {
    return Repo.all(DB.SHEET.USERS).map(function (u) {
      return {
        user_id: u.user_id, username: u.username, full_name: u.full_name,
        role: u.role, division: u.division, branch: u.branch,
        phone: u.phone, status: u.status,
        must_change_pin: u.must_change_pin === true || u.must_change_pin === 'TRUE',
        last_login_at: u.last_login_at
      };
    });
  });
}

function apiCreateUser(payload) {
  return withGuard_(payload, { permission: 'USER_MANAGE', lock: true }, function (session) {
    var d = payload.data || {};
    var username = String(d.username || '').trim().toLowerCase();

    if (!/^[a-z0-9._-]{3,20}$/.test(username)) {
      throw appErr_('BAD_USERNAME', 'Username 3-20 karakter: huruf kecil, angka, titik, atau strip.');
    }
    if (!String(d.full_name || '').trim()) throw appErr_('BAD_NAME', 'Nama lengkap wajib diisi.');
    if (DB.ROLES.indexOf(d.role) < 0) throw appErr_('BAD_ROLE', 'Role tidak dikenal.');
    if (DB.BRANCHES.indexOf(d.branch) < 0) throw appErr_('BAD_BRANCH', 'Cabang tidak dikenal.');
    if (!/^\d{6}$/.test(String(d.pin || ''))) throw appErr_('BAD_PIN', 'PIN awal harus 6 digit angka.');

    var id = createUser_({
      username: username,
      full_name: String(d.full_name).trim(),
      role: d.role,
      division: d.division || '',
      branch: d.branch,
      phone: d.phone || '',
      email: d.email || '',
      sales_code: String(d.sales_code || '').trim().toUpperCase(),
      pin: String(d.pin),
      created_by: session.user_id
    });

    logAudit_(session, {
      entity: 'USER', entity_id: id, action: 'CREATE',
      new_value: username + ' / ' + d.role + ' / ' + d.branch
    });
    return { user_id: id };
  });
}

function apiUpdateUser(payload) {
  return withGuard_(payload, { permission: 'USER_MANAGE', lock: true }, function (session) {
    var d = payload.data || {};
    var u = Repo.findOne(DB.SHEET.USERS, 'user_id', d.user_id);
    if (!u) throw appErr_('NOT_FOUND', 'User tidak ditemukan.');

    var patch = {}, changes = [];
    ['full_name', 'role', 'division', 'branch', 'phone', 'email', 'status'].forEach(function (f) {
      if (d[f] !== undefined && String(d[f]) !== String(u[f])) {
        patch[f] = d[f];
        changes.push({ field: f, from: u[f], to: d[f] });
      }
    });
    if (!changes.length) return { changed: 0 };

    if (patch.role && DB.ROLES.indexOf(patch.role) < 0) throw appErr_('BAD_ROLE', 'Role tidak dikenal.');

    // Jangan sampai tidak ada Super Admin tersisa
    if ((patch.role && u.role === 'SUPERADMIN' && patch.role !== 'SUPERADMIN') ||
        (patch.status && u.role === 'SUPERADMIN' && patch.status !== 'ACTIVE')) {
      var aktif = Repo.all(DB.SHEET.USERS).filter(function (x) {
        return x.role === 'SUPERADMIN' && x.status === 'ACTIVE';
      });
      if (aktif.length <= 1) {
        throw appErr_('LAST_ADMIN', 'Ini satu-satunya Super Admin aktif. Buat penggantinya dulu.');
      }
    }

    patch.updated_at = nowIso_();
    patch.updated_by = session.user_id;
    Repo.update(DB.SHEET.USERS, u._row, patch);

    if (patch.status && patch.status !== 'ACTIVE') revokeAllSessionsOf_(u.user_id);

    changes.forEach(function (c) {
      logAudit_(session, {
        entity: 'USER', entity_id: u.user_id, action: 'UPDATE',
        field: c.field, old_value: c.from, new_value: c.to, reason: d.reason || ''
      });
    });
    return { changed: changes.length };
  });
}

/**
 * Menghapus akun.
 *
 * Akun yang pernah dipakai TIDAK dihapus dari database, hanya
 * dinonaktifkan. Alasannya: setiap catatan audit, timeline, dan
 * transaksi menunjuk ke user_id-nya. Kalau barisnya hilang, riwayat
 * lama jadi menunjuk ke orang yang tidak ada — dan jejak yang tidak
 * bisa dibaca sama saja dengan tidak ada jejak.
 *
 * Akun yang belum pernah dipakai sama sekali boleh dihapus betulan,
 * karena tidak ada yang menunjuk ke sana. Biasanya ini akun yang
 * salah dibuat lalu langsung disadari.
 */
function apiDeleteUser(payload) {
  return withGuard_(payload, { permission: 'USER_MANAGE', lock: true }, function (session) {
    var u = Repo.findOne(DB.SHEET.USERS, 'user_id', payload.user_id);
    if (!u) throw appErr_('NOT_FOUND', 'User tidak ditemukan.');

    if (String(u.user_id) === String(session.user_id)) {
      throw appErr_('SELF', 'Anda tidak bisa menghapus akun Anda sendiri.');
    }

    if (String(u.role) === 'SUPERADMIN') {
      var aktif = Repo.all(DB.SHEET.USERS).filter(function (x) {
        return x.role === 'SUPERADMIN' && x.status === 'ACTIVE' &&
               String(x.user_id) !== String(u.user_id);
      });
      if (!aktif.length) {
        throw appErr_('LAST_ADMIN', 'Ini satu-satunya Super Admin aktif. Buat penggantinya dulu.');
      }
    }

    // Apakah akun ini pernah meninggalkan jejak?
    var terpakai = false;
    try {
      Repo.columns(DB.SHEET.AUDIT, ['log_id', 'actor_user_id']).forEach(function (r) {
        if (String(r.actor_user_id) === String(u.user_id)) terpakai = true;
      });
    } catch (e) { terpakai = true; }

    if (!terpakai) {
      try {
        Repo.columns(DB.SHEET.TRX, ['trx_id', 'sales_user_id', 'gudang_user_id', 'tech_user_id'])
          .forEach(function (r) {
            if ([r.sales_user_id, r.gudang_user_id, r.tech_user_id]
                .map(String).indexOf(String(u.user_id)) >= 0) terpakai = true;
          });
      } catch (e) { terpakai = true; }
    }

    revokeAllSessionsOf_(u.user_id);

    /*
     * Hapus permanen, kalau memang diminta.
     *
     * Bawaannya menonaktifkan: nama akun menempel pada riwayat
     * transaksi, dan menghapusnya membuat jejak lama kehilangan
     * pelakunya.
     *
     * Tapi akun yang salah dibuat — salah ketik nama, salah peran,
     * dibuat dua kali — memang perlu hilang. Yang dipaksa pun tetap
     * tercatat di Riwayat Perubahan, jadi penghapusannya sendiri
     * tidak hilang jejak.
     */
    if (terpakai && Util.isTrue(payload.paksa)) {
      Repo.deleteRow(DB.SHEET.USERS, u._row);
      logAudit_(session, {
        entity: 'USER', entity_id: u.user_id, action: 'DELETE',
        old_value: u.username + ' · ' + u.full_name + ' · ' + u.role,
        new_value: '(dihapus permanen)',
        reason: payload.reason || 'Dihapus paksa oleh Super Admin'
      });
      flushLog_();

      return {
        mode: 'HAPUS_PAKSA',
        pesan: 'Akun ' + u.username + ' dihapus permanen. Riwayat lamanya tetap ' +
               'menyimpan namanya sendiri.'
      };
    }

    if (terpakai) {
      Repo.update(DB.SHEET.USERS, u._row, {
        status: 'DISABLED',
        updated_at: nowIso_(), updated_by: session.user_id
      });
      logAudit_(session, {
        entity: 'USER', entity_id: u.user_id, action: 'UPDATE', field: 'status',
        old_value: String(u.status), new_value: 'DISABLED',
        reason: payload.reason || 'Dihapus dari layar kelola user'
      });
      return {
        mode: 'NONAKTIF', bisa_paksa: true,
        pesan: 'Akun ' + u.username + ' dinonaktifkan. Tidak bisa login lagi, ' +
               'tapi namanya tetap terbaca di riwayat transaksi lama.'
      };
    }

    Repo.deleteRow(DB.SHEET.USERS, u._row);
    logAudit_(session, {
      entity: 'USER', entity_id: u.user_id, action: 'DELETE',
      old_value: u.username + ' · ' + u.full_name + ' · ' + u.role,
      new_value: '(dihapus)',
      reason: payload.reason || 'Akun belum pernah dipakai'
    });

    return {
      mode: 'HAPUS',
      pesan: 'Akun ' + u.username + ' dihapus. Akun ini belum pernah dipakai, ' +
             'jadi tidak ada riwayat yang terputus.'
    };
  });
}

function apiResetUserPin(payload) {
  return withGuard_(payload, { permission: 'USER_MANAGE', lock: true }, function (session) {
    var newPin = String(payload.newPin || '').trim();
    if (!/^\d{6}$/.test(newPin)) throw appErr_('BAD_PIN', 'PIN harus 6 digit angka.');

    var u = Repo.findOne(DB.SHEET.USERS, 'user_id', payload.user_id);
    if (!u) throw appErr_('NOT_FOUND', 'User tidak ditemukan.');

    var salt = randomSalt_();
    Repo.update(DB.SHEET.USERS, u._row, {
      pin_salt: salt, pin_hash: hashPin_(salt, newPin),
      must_change_pin: true, failed_attempt: 0, status: 'ACTIVE',
      updated_at: nowIso_(), updated_by: session.user_id
    });
    revokeAllSessionsOf_(u.user_id);

    logAudit_(session, {
      entity: 'USER', entity_id: u.user_id, action: 'UPDATE',
      field: 'pin', old_value: '(rahasia)', new_value: '(direset admin)',
      reason: payload.reason || ''
    });
    return { done: true };
  });
}

function apiRecentAudit(payload) {
  return withGuard_(payload, { permission: 'AUDIT_VIEW' }, function () {
    var rows = Repo.all(DB.SHEET.AUDIT);
    return rows.slice(-80).reverse().map(function (r) {
      return {
        at: r.at, actor: r.actor_name, role: r.actor_role,
        entity: r.entity, entity_id: r.entity_id, action: r.action,
        field: r.field, old_value: r.old_value, new_value: r.new_value, reason: r.reason
      };
    });
  });
}
