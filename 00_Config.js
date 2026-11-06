/**
 * ELS.ID WORKFLOW SYSTEM
 * File : 00_Config.gs  (v4)
 * Isi  : Definisi struktur database. Tidak ada logika di sini.
 *
 * Baru di v4:
 * - Kolom sales_type di SALES_LIST dan TRANSACTIONS.
 *   Diambil dari huruf tengah kode sales:
 *       SPW - O - MANTO
 *        |    |    └ nama
 *        |    └ jalur penjualan (Online / Ritel / Promotor)
 *        └ tim atau cabang
 * - Pemetaan hurufnya disimpan di SETTINGS (SALES_TYPE_MAP),
 *   jadi jalur baru bisa ditambah tanpa mengubah kode.
 */

var DB = {};

DB.SHEET = {
  USERS:        'USERS',
  SESSIONS:     'SESSIONS',
  CUSTOMERS:    'CUSTOMERS',
  PRODUCTS:     'PRODUCTS_LOCAL',
  SYNC_LOG:     'PRODUCT_SYNC_LOG',
  SALES:        'SALES_LIST',
  GUDANG:       'GUDANG_LIST',
  EKSEKUSI:     'EKSEKUSI_LIST',
  TEKNISI:      'TEKNISI_LIST',
  CHAT:         'TRX_CHAT',
  TECH_WORK:    'TECH_WORK',
  TRX:          'TRANSACTIONS',
  ITEMS:        'TRANSACTION_ITEMS',
  SN:           'TRANSACTION_SN',
  PAYMENTS:     'PAYMENTS',
  TIMELINE:     'TRX_TIMELINE',
  AUDIT:        'AUDIT_LOG',
  NOTIF:        'NOTIFICATIONS',
  COUNTERS:     'COUNTERS',
  SETTINGS:     'SETTINGS',
  STATUS:       'STATUS_MASTER',
  TRX_ARCHIVE:  'TRANSACTIONS_ARCHIVE'
};

DB.HEADERS = {};

DB.HEADERS[DB.SHEET.USERS] = [
  'user_id','username','full_name','role','division','branch',
  'pin_hash','pin_salt','phone','email','status','must_change_pin',
  'last_login_at','failed_attempt',
  'created_at','created_by','updated_at','updated_by','notes',

  /*
   * Dua kolom ini ditambahkan belakangan, jadi tempatnya di akhir —
   * sama seperti di sheet. Penulisan akun baru memakai urutan
   * kolom, dan menyisipkan di tengah akan menggeser isinya.
   */
  'menu_urut','sales_code'
];

DB.HEADERS[DB.SHEET.SESSIONS] = [
  'token','user_id','role','branch',
  'created_at','expires_at','last_seen_at','device_info','is_revoked'
];

DB.HEADERS[DB.SHEET.CUSTOMERS] = [
  'customer_id','full_name','phone','phone_norm','email','address',
  'member_code','source','branch',
  'created_at','created_by','updated_at','updated_by',
  'trx_count','last_trx_at','notes','is_active'
];

DB.HEADERS[DB.SHEET.PRODUCTS] = [
  'product_code','product_name','category','unit','price','stock',
  'need_sn','is_active','search_key','synced_at'
];

DB.HEADERS[DB.SHEET.GUDANG] = [
  'gudang_code','gudang_name','branch','phone','notes','is_active',
  'created_at','created_by','updated_at','updated_by'
];

/*
 * Daftar teknisi.
 *
 * Akun Teknisi dipakai bersama satu meja, sama seperti Gudang. Supaya
 * laporan bulanan bisa dipecah per orang, namanya dipilih saat mulai
 * aktivasi dan tersimpan di transaksinya.
 */
/*
 * Daftar PIC Tim Eksekusi.
 *
 * Satu akun divisi dipakai bersama, sama seperti Gudang dan Teknisi.
 * Nama PIC-nya dipilih saat mulai menyiapkan, supaya ketahuan siapa
 * yang memegang order online itu.
 */
DB.HEADERS[DB.SHEET.EKSEKUSI] = [
  'pic_code','pic_name','branch','phone','notes','is_active',
  'created_at','created_by','updated_at','updated_by'
];

DB.HEADERS[DB.SHEET.TEKNISI] = [
  'tech_code','tech_name','branch','phone','notes','is_active',
  'created_at','created_by','updated_at','updated_by'
];

/*
 * Pekerjaan teknisi yang tidak menempel pada penjualan.
 *
 * Upgrade RAM, rakit PC, inkcharging, dan sejenisnya tidak selalu ada
 * transaksinya — tapi tetap pekerjaan yang harus terhitung. Yang dari
 * penjualan tidak dicatat di sini; itu dihitung langsung dari isi
 * transaksi supaya tidak bisa dilebihkan.
 */
/*
 * Percakapan yang menempel pada satu transaksi.
 *
 * Koordinasi antar divisi selama ini lewat WhatsApp — terpisah dari
 * pesanannya, hilang setelah tertimbun pesan lain, dan tidak bisa
 * ditelusuri saat ada yang dipertanyakan.
 *
 * Di sini pesannya menempel pada transaksinya sendiri: siapa pun
 * yang membuka pesanan itu melihat seluruh percakapannya.
 */
DB.HEADERS[DB.SHEET.CHAT] = [
  'chat_id','trx_id','trx_no','branch','role','user_id','user_name',
  'tujuan','pesan','created_at','dibaca','is_void'
];

DB.HEADERS[DB.SHEET.TECH_WORK] = [
  'work_id','tgl','branch','tech_code','tech_name','jenis','jumlah',
  'keterangan','trx_no','created_at','created_by','is_void'
];

DB.HEADERS[DB.SHEET.SYNC_LOG] = [
  'sync_id','started_at','finished_at','mode','triggered_by',
  'rows_read','rows_written','rows_changed','status','message'
];

/** Daftar sales. Ini BUKAN akun login — akun login ada di USERS. */
DB.HEADERS[DB.SHEET.SALES] = [
  'sales_code','sales_name','sales_type','branch','phone','is_active',
  'created_at','created_by','updated_at','updated_by','notes'
];

DB.HEADERS[DB.SHEET.TRX] = [
  'trx_id','trx_no','branch','trx_date',
  'customer_id','cust_name_snap','cust_phone_snap','cust_member_snap',
  'sales_user_id','sales_name',
  'stage_status','payment_status','order_note','item_count',
  'subtotal','discount_total','grand_total','paid_total','outstanding',
  'nota_no','nota_by','nota_at',
  'sales_confirm_by','sales_confirm_at',
  'gudang_user_id','gudang_confirm_at',
  'resep_print_count','resep_last_print_at','resep_last_print_by',
  'cashier_user_id','paid_at',
  'channel','sumber','gedung','metode_serah','faktur_pajak',
  'cara_bayar','tempo_hari','dp_info',
  'perlu_teknisi','kerja_teknisi','catatan_teknisi','tek_dulu',
  'serah_driver','serah_resi','tempo_jatuh','tempo_by',
  'eksekusi_pic','eksekusi_pic_nama',
  'tech_user_id','tech_petugas','tech_petugas_nama',
  'activation_start_at','activation_done_at','completed_at',
  'revision',
  'created_at','created_by','updated_at','updated_by','updated_by_name',
  'is_void','void_reason','void_by','void_at','override_flags',
  'sales_code','sales_type','gudang_petugas','gudang_petugas_nama',
  'nota_indent','nota_indent_at','nota_indent_by'
];

DB.HEADERS[DB.SHEET.TRX_ARCHIVE] = DB.HEADERS[DB.SHEET.TRX];

DB.HEADERS[DB.SHEET.ITEMS] = [
  'item_id','trx_id','trx_no','line_no',
  'product_code','product_name','source',
  'qty','unit_price','master_price','base_price','line_total',
  'need_sn','sn_required_qty','sn_filled_qty','sn_summary','item_note',
  'prepared','prepared_by','prepared_at',
  'is_active','void_reason',
  'created_at','created_by','updated_at','updated_by'
];

DB.HEADERS[DB.SHEET.SN] = [
  'sn_id','trx_id','trx_no','item_id','product_code','unit_seq',
  'serial_number','input_by','input_at','is_active','replaced_reason'
];

DB.HEADERS[DB.SHEET.PAYMENTS] = [
  'payment_id','trx_id','trx_no','seq','type','amount','method','ref_no',
  'paid_at','cashier_user_id','cashier_name','note',
  'is_void','void_reason','void_by','void_at','created_at'
];

DB.HEADERS[DB.SHEET.TIMELINE] = [
  'timeline_id','trx_id','trx_no','at','event_code','event_label',
  'actor_user_id','actor_name','actor_role','stage_after','detail'
];

DB.HEADERS[DB.SHEET.AUDIT] = [
  'log_id','at','actor_user_id','actor_name','actor_role',
  'entity','entity_id','trx_no','action','field',
  'old_value','new_value','reason','source_page','session_token_short'
];

DB.HEADERS[DB.SHEET.NOTIF] = [
  'notif_id','created_at','target_role','target_branch','target_user_id',
  'trx_id','trx_no','type','priority','title','body',
  'read_by','acted_by','acted_at','expires_at','is_active'
];

DB.HEADERS[DB.SHEET.COUNTERS] = [
  'counter_key','scope_date','last_number','updated_at'
];

DB.HEADERS[DB.SHEET.SETTINGS] = [
  'key','value','value_type','group','description','updated_at','updated_by'
];

DB.HEADERS[DB.SHEET.STATUS] = [
  'status_code','label','type','order','color_hex','icon',
  'owner_role','next_allowed','is_terminal'
];

DB.COL_WIDTH = {};
DB.COL_WIDTH[DB.SHEET.TRX]      = { trx_no: 170, cust_name_snap: 180, order_note: 260,
                                    sales_code: 150, sales_type: 110 };
DB.COL_WIDTH[DB.SHEET.ITEMS]    = { product_name: 260, sn_summary: 220, item_note: 200 };
DB.COL_WIDTH[DB.SHEET.AUDIT]    = { old_value: 200, new_value: 200, reason: 200 };
DB.COL_WIDTH[DB.SHEET.TIMELINE] = { event_label: 320, detail: 240 };
DB.COL_WIDTH[DB.SHEET.SETTINGS] = { description: 340, value: 220 };
DB.COL_WIDTH[DB.SHEET.PRODUCTS] = { product_name: 280, search_key: 240 };
DB.COL_WIDTH[DB.SHEET.SALES]    = { sales_code: 170, sales_name: 200, sales_type: 110, notes: 240 };

DB.TAB_COLOR = {
  'USERS':'#5b6b7a', 'SESSIONS':'#5b6b7a',
  'CUSTOMERS':'#2e7d32',
  'PRODUCTS_LOCAL':'#0277bd', 'PRODUCT_SYNC_LOG':'#0277bd',
  'SALES_LIST':'#00838f',
  'TRANSACTIONS':'#e65100', 'TRANSACTION_ITEMS':'#ef6c00',
  'TRANSACTION_SN':'#f57c00', 'PAYMENTS':'#6a1b9a',
  'TRX_TIMELINE':'#455a64', 'AUDIT_LOG':'#455a64',
  'NOTIFICATIONS':'#c62828',
  'COUNTERS':'#9e9e9e', 'SETTINGS':'#9e9e9e', 'STATUS_MASTER':'#9e9e9e',
  'TRANSACTIONS_ARCHIVE':'#bdbdbd'
};

/*
 * Daftar peran yang diakui sistem.
 *
 * Ada tiga tempat yang menyebut peran: izin di 03_Auth, menu di
 * JsCore, dan daftar ini. Yang ini yang memeriksa saat akun dibuat —
 * jadi peran yang sudah punya izin dan menu tetap ditolak kalau
 * belum terdaftar di sini.
 */
DB.ROLES = ['SALES','SALES_ONLINE','GUDANG','EKSEKUSI',
            'ADMIN','KASIR','TEKNISI','SUPERADMIN'];

DB.BRANCHES = ['PWT_KOTA','PURBALINGGA','KEBUMEN'];

/** Isi awal SALES_LIST: [kode, nama, cabang] — jalurnya dibaca dari kode */
DB.DEFAULT_SALES = [
  ['SPW-O-MANTO', 'Manto', 'PWT_KOTA'],
  ['SPW-R-RIRIH', 'Ririh', 'PWT_KOTA'],
  ['SPW-R-KHOTI', 'Khoti', 'PWT_KOTA'],
  ['SPW-R-DIAN',  'Dian',  'PWT_KOTA']
];

DB.DEFAULT_SETTINGS = [
  ['CENTER_SPREADSHEET_ID','', 'TEXT',  'SYNC',   'ID Spreadsheet master barang milik pusat (READ ONLY). Diisi nanti.'],
  ['MIRROR_SPREADSHEET_ID','', 'TEXT',  'SYNC',   'ID file mirror berisi formula IMPORTRANGE. Diisi nanti.'],
  ['CENTER_RANGE',         'Sheet1!A:D','TEXT','SYNC','Range yang diambil dari spreadsheet pusat.'],
  ['SYNC_INTERVAL_MIN',    '15','NUMBER','SYNC',   'Interval sinkronisasi master barang (menit).'],
  ['SN_RULE_PREFIX',       'LPT,HP,PRN,CCTV','TEXT','PRODUK','Prefix kode barang yang wajib Serial Number.'],
  ['MAX_DISCOUNT_PCT_SALES','5','NUMBER','SALES',  'Batas diskon (%) yang boleh diberikan Sales tanpa approval. Isi 100 untuk mematikan pembatasan.'],
  ['SALES_CODE_REQUIRED',  'TRUE','TEXT','SALES',  'Wajib memilih kode sales sebelum pesanan dikonfirmasi.'],
  ['SALES_TYPE_MAP',       'O=Online,R=Ritel,P=Promotor','TEXT','SALES',
                           'Arti huruf tengah pada kode sales. Contoh kode SPW-O-MANTO berarti jalur Online. ' +
                           'Tambahkan jalur baru di sini, pisahkan dengan koma. Contoh: K=Korporat'],
  ['PULSE_INTERVAL_SEC',   '12','NUMBER','NOTIF',  'Jeda pengecekan notifikasi oleh browser (detik).'],
  ['SESSION_HOURS',        '12','NUMBER','AUTH',   'Masa berlaku sesi login (jam).'],
  ['IDLE_LOGOUT_MIN',      '30','NUMBER','AUTH',   'Logout otomatis setelah diam sekian menit.'],
  ['MAX_FAILED_LOGIN',     '5', 'NUMBER','AUTH',   'Jumlah salah PIN sebelum akun disuspend.'],
  ['RECALL_COOLDOWN_SEC',  '120','NUMBER','NOTIF', 'Jeda minimal tombol Panggil Gudang oleh Sales (detik).'],
  ['STUCK_ALERT_MIN',      '30','NUMBER','NOTIF',  'Transaksi dianggap tertahan bila diam di satu tahap sekian menit.'],
  ['SOUND_ENABLED_ROLES',  'GUDANG,TEKNISI','TEXT','NOTIF','Role yang wajib mengaktifkan suara notifikasi.'],
  ['MEMBER_LINK',          'https://member.els.id/','TEXT','CUSTOMER','Link pendaftaran member ELS.'],
  ['NOTA_PREFIX',          'INV/ELS','TEXT','ADMIN','Awalan nomor nota.'],
  ['TRX_PREFIX',           'TRX','TEXT','TRX',     'Awalan nomor transaksi.'],
  ['TRX_NO_ON_CONFIRM',    'FALSE','TEXT','TRX',   'TRUE = nomor transaksi terbit saat konfirmasi, bukan saat pesanan dibuat.'],
  ['SUMBER_ONLINE',
   'WA Hotline,Instagram,Facebook,TikTok,Shopee,Tokopedia,Lazada,TikTok Shop,BliBli,Web',
   'TEXT','ONLINE',
   'Pilihan asal pesanan online, dipisah koma. Dipakai untuk menilai saluran mana yang paling produktif.'],
  ['CARA_BAYAR_ONLINE', 'Lunas,DP (uang muka),Belum bayar',
   'TEXT','ONLINE',
   'Pilihan cara bayar selain tempo, dipisah koma. Pilihan tempo dibuat otomatis dari TEMPO_HARI.'],
  ['TEMPO_HARI', '3,7,14,30,45,60,90', 'TEXT','ONLINE',
   'Pilihan lama tempo dalam hari, dipisah koma.'],
  ['KERJA_TEKNISI', 'Aktivasi,Rakit PC,Inkcharging,Cek unit,Instal ulang',
   'TEXT','ONLINE',
   'Pilihan pekerjaan yang diminta Eksekusi ke Teknisi, dipisah koma. Dipilih saat meneruskan pesanan.'],
  ['GEDUNG_LIST', 'G-UTARA,G-SELATAN', 'TEXT','ONLINE',
   'Pilihan gedung tempat barang diambil, dipisah koma. G-UTARA gedung NB (ada petugas gudang), G-SELATAN gedung PC dan aksesori (barang terdisplay).'],
  ['METODE_SERAH',
   'DI-AMBIL,KIRIM DRIVER,PAKET,GOSEND / GRAB',
   'TEXT','ONLINE',
   'Pilihan cara barang sampai ke customer, dipisah koma.'],
  ['KATEGORI_TEKNISI',
   'McAfee=MCAFEE,ANTIVIRUS|Screen=SCREEN,ANTIGORES|Skin Laptop=SKIN|' +
   'Office Profesional=OFFICE,OFC|Aktivasi Laptop=AKTIVASI LAPTOP',
   'TEXT','TEKNISI',
   'Kategori pekerjaan yang dihitung otomatis dari barang di pesanan. Bentuknya Nama=kata1,kata2 dipisah tanda |. Dicocokkan dengan nama dan kode barang.'],
  ['JENIS_KERJA_MANUAL',
   'Upgrade RAM,Upgrade SSD,Rakit PC,Inkcharging,Bundling Office Pro 2021,' +
   'Pasang Screen,Pasang SKIN,Aktivasi Laptop,Onsite Service',
   'TEXT','TEKNISI',
   'Pilihan jenis pekerjaan yang dicatat manual Teknisi, dipisah koma. "Pekerjaan lain" selalu tersedia untuk yang diketik sendiri.'],
  ['SALES_LIHAT_SETELAH_KASIR', 'FALSE','TEXT','AKSES',
   'TRUE = Sales bisa membuka rincian transaksi sampai selesai. FALSE = rinciannya ditutup begitu masuk Kasir. Dipakai untuk menjaga agar promotor brand tidak melihat penjualan brand lain.'],
  ['ARCHIVE_AFTER_DAYS',   '30','NUMBER','SYSTEM', 'Transaksi selesai dipindah ke berkas arsip setelah sekian hari. Barang, SN, pembayaran, dan riwayatnya ikut pindah.'],
  ['ARCHIVE_MAX_PER_RUN', '300','NUMBER','SYSTEM', 'Batas jumlah transaksi yang dipindah dalam sekali jalan, supaya tidak kehabisan waktu.'],
  ['BACKUP_KEEP_DAYS',     '30','NUMBER','SYSTEM', 'Lama backup harian disimpan di Drive.'],
  ['COMPANY_NAME',         'ELS.ID Purwokerto','TEXT','BRAND','Nama yang tampil di resep dan header aplikasi.'],
  ['COMPANY_ADDRESS',      '', 'TEXT','BRAND',     'Alamat toko untuk cetak resep.'],
  ['COMPANY_PHONE',        '', 'TEXT','BRAND',     'Nomor telepon/WA toko untuk cetak resep.'],
  ['BRAND_COLOR',          '#0B5FFF','TEXT','BRAND','Warna aksen aplikasi (hex).'],
  ['LOGO_URL',             '', 'TEXT','BRAND',     'URL logo ELS.ID untuk resep.'],
  ['PAPER_SIZE',           'A5','TEXT','ADMIN',    'Ukuran kertas cetak resep: A4 / A5 / STRUK.'],
  ['DEFAULT_BRANCH',       'PWT_KOTA','TEXT','SYSTEM','Cabang default saat membuat user baru.'],
  ['APP_VERSION',          '0.3-phase2','TEXT','SYSTEM','Versi aplikasi yang sedang berjalan.']
];

DB.DEFAULT_STATUS = [
  ['DRAFT','Draft Pesanan','STAGE',10,'#9e9e9e','⚪','SALES','MENUNGGU_GUDANG',false],
  ['MENUNGGU_GUDANG','Menunggu Gudang','STAGE',20,'#1e88e5','🔵','GUDANG','PROSES_GUDANG,SIAP_NOTA',false],
  ['PROSES_GUDANG','Proses Gudang','STAGE',30,'#fb8c00','🟠','GUDANG','SIAP_NOTA',false],
  ['SIAP_NOTA','Siap Dibuat Nota','STAGE',40,'#6d4c41','🧾','ADMIN','MENUNGGU_PEMBAYARAN,PROSES_GUDANG',false],
  ['MENUNGGU_PEMBAYARAN','Menunggu Pembayaran','STAGE',50,'#f9a825','💰','KASIR','MENUNGGU_AKTIVASI',false],
  ['MENUNGGU_AKTIVASI','Menunggu Aktivasi','STAGE',60,'#8e24aa','🟣','TEKNISI','PROSES_AKTIVASI',false],
  ['PROSES_AKTIVASI','Proses Aktivasi','STAGE',70,'#00897b','🔧','TEKNISI','AKTIVASI_SELESAI',false],
  ['AKTIVASI_SELESAI','Aktivasi Selesai','STAGE',80,'#43a047','🟢','TEKNISI','SELESAI',false],
  ['SELESAI','Transaksi Selesai','STAGE',90,'#2e7d32','✅','','',true],
  ['DIBATALKAN','Dibatalkan','STAGE',99,'#c62828','⛔','SUPERADMIN','',true],

  ['BELUM_BAYAR','Belum Bayar','PAYMENT',10,'#e53935','🔴','KASIR','DP,LUNAS',false],
  ['DP','DP / Sebagian','PAYMENT',20,'#fdd835','🟡','KASIR','LUNAS',false],
  ['LUNAS','Lunas','PAYMENT',30,'#43a047','🟢','KASIR','REFUND',true],
  ['REFUND','Refund','PAYMENT',40,'#424242','⚫','SUPERADMIN','',true]
];
