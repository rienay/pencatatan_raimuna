/**
 * JavaScript App Logic: Bendahara Raimuna Cabang Cilacap
 * Stored locally via IndexedDB, syncs with Google Sheets.
 */

// Global App State
const state = {
  transactions: [],
  categories: [],
  sources: [],
  utang: [],
  utangFilter: 'ALL',
  settings: {
    sheetUrl: 'https://script.google.com/macros/s/AKfycbwG2W4toZtjXFk5UmWt9xemdTqyodjqEOfQzXYEs1uMMNzJdqBWtUhW2o4aJ1-aq4W6pQ/exec',
    autoSync: true
  },
  filters: {
    search: '',
    tipe: 'ALL',
    bulan: 'ALL',
    tahun: 'ALL',
    kategori: 'ALL',
    sumberDana: 'ALL',
    sync: 'ALL'
  },
  sort: {
    column: 'tanggal',
    direction: 'asc' // asc, desc
  },
  currentUpload: null, // Holds { name, type, base64 } for new txn
  charts: {
    flow: null,
    category: null
  },
  sponsorshipHistory: [],
  db: null
};

// IndexedDB Helper Variables
const DB_NAME = 'RaimunaCilacapDB';
const DB_VERSION = 4; // Upgraded: tambah store deleted_ids untuk tombstone sync
const STORE_TXNS = 'transactions';
const STORE_CATS = 'categories';
const STORE_SRCS = 'sources';
const STORE_SETTINGS = 'settings';
const STORE_SPONSORSHIPS = 'sponsorship_history';
const STORE_UTANG = 'utang';
const STORE_DELETED_IDS = 'deleted_ids'; // Tombstone: ID yang dihapus lokal tapi belum terkirim ke Sheet

// Helper functions for Kategori & Sumber Dana
function getTxCategory(tx) {
  if (!tx) return '-';
  if (tx.kategori && tx.kategori !== '' && tx.kategori !== 'ALL') return tx.kategori;
  if (tx.tipe === 'OUT') return tx.kategoriSumber || '-';
  return '-';
}

function getTxSumber(tx) {
  if (!tx) return '-';
  if (tx.sumberDana && tx.sumberDana !== '' && tx.sumberDana !== 'ALL') return tx.sumberDana;
  if (tx.sumber && tx.sumber !== '' && tx.sumber !== 'ALL') return tx.sumber;
  if (tx.tipe === 'IN') return tx.kategoriSumber || '-';
  return '-';
}

function parseSheetRow(row) {
  let tipe = row.tipe;
  let kategori = row.kategori;
  let sumberDana = row.sumberDana;
  let pic = row.pic;
  let nominal = parseInt(row.nominal, 10);
  let keterangan = row.keterangan || '';

  // Check if row has blank column shift (Column F in Google Sheets is blank):
  // When shifted: row.pic contains numeric nominal (e.g. 500000), row.nominal contains text keterangan, row[""] or row.col5 contains real pic (e.g. "said")
  const rawPic = String(pic || '').trim();
  const rawNominal = String(row.nominal || '').trim();
  const blankCol = row[''] || row['col5'] || row['COL5'] || '';

  if (/^\d+$/.test(rawPic) && (isNaN(nominal) || !/^\d+$/.test(rawNominal))) {
    // Row is shifted due to extra blank column!
    nominal = parseInt(rawPic, 10) || 0;
    pic = blankCol ? String(blankCol).trim() : '-';
    keterangan = row.nominal ? String(row.nominal).trim() : keterangan;
  } else {
    nominal = isNaN(nominal) ? (parseInt(rawNominal, 10) || 0) : nominal;
  }

  // Fallbacks for Kategori & Sumber Dana
  if (!kategori || kategori === '' || kategori === '-') {
    if (tipe === 'OUT') kategori = row.kategoriSumber || '-';
    else kategori = '-';
  }
  
  if (!sumberDana || sumberDana === '' || sumberDana === '-') {
    if (tipe === 'IN') sumberDana = row.kategoriSumber || '-';
    else sumberDana = '-';
  }

  if (!pic || pic === '' || pic === '-') {
    pic = '-';
  }

  return {
    id: row.id,
    tanggal: formatDateString(row.tanggal),
    tipe: tipe,
    kategori: kategori,
    sumberDana: sumberDana,
    kategoriSumber: row.kategoriSumber || (tipe === 'IN' ? sumberDana : kategori),
    pic: String(pic).trim(),
    nominal: nominal,
    keterangan: String(keterangan).trim(),
    dateCreated: row.dateCreated || new Date().toISOString(),
    attachment: null,
    sync: true
  };
}

function parseKwitansiRow(row) {
  if (!row) return null;
  const no = row.no || row['No. Kwitansi'] || row['No.'] || row['No'] || row.noKwitansi || '';
  const tipeJenis = row.tipeJenis || row['Tipe'] || row['Jenis'] || row['Tipe Jenis'] || 'SPONSORSHIP';
  const tgl = row.tgl || row['Tanggal'] || row.tanggal || '';
  const dari = row.dari || row['Diterima Dari'] || row['Telah Diterima Dari'] || row['Diterima Dan'] || row.pemberi || '';
  const rawNominal = row.nominal !== undefined ? row.nominal : (row['Nominal / Jumlah'] || row['Nominal (Rp)'] || row['Nominal'] || 0);
  const terbilang = row.terbilang || row['Terbilang'] || '';
  const guna = row.guna || row['Keperluan'] || row['Guna'] || '';
  const penerima = row.penerima || row['Penerima'] || row['Penandatangan (Ketua Panitia)'] || '';
  const nta = row.nta || row['NTA'] || row['NTA / Jabatan'] || '';
  const id = row.id || ('KW-' + Math.random().toString(36).substring(2, 8));

  let normalizedTipe = String(tipeJenis).toUpperCase();
  if (normalizedTipe.includes('JELANTAH')) normalizedTipe = 'JELANTAH';
  else if (normalizedTipe.includes('TENANT') || normalizedTipe.includes('STAND')) normalizedTipe = 'STAND';
  else if (normalizedTipe.includes('SPONSOR')) normalizedTipe = 'SPONSORSHIP';

  let finalNominal = rawNominal;
  if (typeof rawNominal === 'string') {
    if (rawNominal.toUpperCase().includes('KG')) {
      finalNominal = rawNominal.trim();
    } else {
      finalNominal = parseRupiah(rawNominal);
    }
  }

  return {
    id: String(id),
    tipeJenis: normalizedTipe,
    no: String(no).replace(/^No\.\s*/i, '').trim(),
    tgl: String(tgl),
    dari: String(dari),
    nominal: finalNominal,
    terbilang: String(terbilang),
    guna: String(guna),
    penerima: String(penerima),
    nta: String(nta),
    dateCreated: row.dateCreated || new Date().toISOString()
  };
}

function parseUtangRow(row) {
  if (!row) return null;
  const id = row.id || row['ID Utang'] || row['ID'] || generateUniqueId('UTG');
  const tanggal = row.tanggal || row['Tanggal'] || '';
  const rawTipe = row.tipe || row['Tipe'] || 'OUT';
  const nama = row.nama || row['Penanggung Jawab / Pihak'] || row['Penanggung Jawab / P'] || row['Penanggung Jawab'] || row['Nama'] || '';
  const sumberDana = row.sumberDana || row['Sumber / Kategori'] || row['Sumber Dana'] || row.kategori || '-';
  const rawNominal = row.nominal !== undefined ? row.nominal : (row['Nominal (Rp)'] || row['Nominal'] || 0);
  const keterangan = row.keterangan || row['Keterangan'] || '';
  const status = row.status || row['Status'] || 'BELUM_LUNAS';
  const paidTxId = row.paidTxId || row['paidTxId'] || null;
  const tanggalLunas = row.tanggalLunas || row['Tanggal Lunas'] || null;

  let normalizedTipe = 'OUT';
  if (String(rawTipe).toUpperCase().includes('MASUK') || String(rawTipe).toUpperCase().includes('PIUTANG') || String(rawTipe).toUpperCase() === 'IN') {
    normalizedTipe = 'IN';
  }

  let normalizedStatus = 'BELUM_LUNAS';
  if (String(status).toUpperCase().includes('LUNAS') && !String(status).toUpperCase().includes('BELUM')) {
    normalizedStatus = 'LUNAS';
  }

  let finalNominal = typeof rawNominal === 'string' ? parseRupiah(rawNominal) : (parseInt(rawNominal, 10) || 0);

  return {
    id: String(id),
    tanggal: formatDateString(tanggal),
    tipe: normalizedTipe,
    nama: String(nama).trim(),
    sumberDana: String(sumberDana).trim(),
    kategori: String(sumberDana).trim(),
    nominal: finalNominal,
    keterangan: String(keterangan).trim(),
    status: normalizedStatus,
    paidTxId: paidTxId && paidTxId !== '-' ? paidTxId : null,
    tanggalLunas: tanggalLunas && tanggalLunas !== '-' ? tanggalLunas : null,
    dateCreated: row.dateCreated || new Date().toISOString()
  };
}

// Default Data Seed arrays
const DEFAULT_SOURCES = [
  'Sponsor', 'APBD', 'Minyak Jelantah', 'Pembayaran Tenant', 'Donatur', 'Iuran Panitia', 'Tanpa Sumber Dana (Dana Talangan)', 'Lainnya'
];

const DEFAULT_CATEGORIES = [
  'Bidang Giat', 'Humas', 'Perlengkapan', 'Konsumsi', 'Dokumentasi', 'Kesehatan', 'Transportasi', 'Sekretariat', 'Lainnya'
];

// Pastel Chart Colors Palette
const PASTEL_PALETTE = [
  '#ffb7b2', '#ffdfba', '#ffffba', '#baffc9', '#bae1ff', 
  '#e8dbfc', '#ffcbd1', '#f5d6eb', '#d0f4de', '#fcf6bd'
];

// Document Elements
let dropzoneIn, dropzoneOut, dropzoneEdit;
let fileIndicatorIn, fileIndicatorOut, fileIndicatorEdit;

// Initialize Application on Page Load
document.addEventListener('DOMContentLoaded', async () => {
  await checkLoginState();
  setupLoginHandler();
  setupDomReferences();
  await initIndexedDB();
  await loadStateFromDB();
  setupNavigation();
  setupFormHandlers();
  setupFilterHandlers();
  setupSettingsHandlers();
  setupExportHandlers();
  setupCustomModals();
  setupSponsorshipHandlers();
  setupUtangHandlers();
  setupAlokasiTalanganModal();
  
  // Set default dates on forms
  const today = new Date().toISOString().split('T')[0];
  if (document.getElementById('in-tanggal')) document.getElementById('in-tanggal').value = today;
  if (document.getElementById('out-tanggal')) document.getElementById('out-tanggal').value = today;
  if (document.getElementById('utang-tanggal')) document.getElementById('utang-tanggal').value = today;
  
  // Render application
  renderApp();
  
  // Auto test connection and background sync if URL exists
  if (state.settings.sheetUrl) {
    updateSyncBadge('unsynced', 'Menghubungkan...');
    await testGoogleSheetsConnection(false);
    // Urutan penting: push pending deletes & unsynced DULU, baru pull (agar data Sheet akurat)
    await pushPendingDeletes();
    await autoSyncPendingTransactions();
    await autoPullFromSheets();
  }
});

// Setup References to DOM elements
function setupDomReferences() {
  dropzoneIn = document.getElementById('in-dropzone');
  dropzoneOut = document.getElementById('out-dropzone');
  dropzoneEdit = document.getElementById('edit-dropzone');
  fileIndicatorIn = document.getElementById('in-file-indicator');
  fileIndicatorOut = document.getElementById('out-file-indicator');
  fileIndicatorEdit = document.getElementById('edit-file-indicator');
  
  // Drag and Drop listeners
  setupFileDropzone(dropzoneIn, 'in-bukti', fileIndicatorIn);
  setupFileDropzone(dropzoneOut, 'out-nota', fileIndicatorOut);
  if (dropzoneEdit) setupFileDropzone(dropzoneEdit, 'edit-bukti', fileIndicatorEdit);
  
  // Numeric Inputs Formatting (Auto Rupiah)
  setupRupiahInput('in-nominal');
  setupRupiahInput('out-nominal');
  setupRupiahInput('utang-nominal');
  
  // Sidebar responsive toggle
  const sidebar = document.querySelector('.sidebar');
  const toggleBtn = document.getElementById('sidebar-toggle');
  
  toggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    sidebar.classList.toggle('open');
  });
  
  document.addEventListener('click', (e) => {
    if (!sidebar.contains(e.target) && e.target !== toggleBtn) {
      sidebar.classList.remove('open');
    }
  });
}

// Setup File drag and drop dropzone logic
function setupFileDropzone(dropzone, inputId, indicator) {
  const fileInput = document.getElementById(inputId);
  
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
  
  dropzone.addEventListener('dragleave', () => {
    dropzone.classList.remove('dragover');
  });
  
  dropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    if (e.dataTransfer.files.length) {
      fileInput.files = e.dataTransfer.files;
      handleMultipleFilesSelected(fileInput.files, indicator);
    }
  });
  
  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) {
      handleMultipleFilesSelected(fileInput.files, indicator);
    } else {
      indicator.textContent = '';
      state.currentUpload = null;
    }
  });
}

// Convert uploaded files to array of Base64 objects
function handleMultipleFilesSelected(files, indicator) {
  if (!files || files.length === 0) return;
  const maxIndividualSize = 4 * 1024 * 1024; // 4MB limit per file
  
  const filesArray = Array.from(files);
  const uploads = [];
  let completed = 0;
  
  indicator.textContent = `Memproses ${filesArray.length} file...`;
  state.currentUpload = null;
  
  filesArray.forEach(file => {
    if (file.size > maxIndividualSize) {
      showToast('Ukuran File Terlalu Besar', `File "${file.name}" melebihi batas 4MB.`, 'error');
      completed++;
      if (completed === filesArray.length) {
        finishUploadProcessing(uploads, indicator);
      }
      return;
    }
    
    const reader = new FileReader();
    reader.onload = function(e) {
      uploads.push({
        name: file.name,
        type: file.type,
        base64: e.target.result
      });
      completed++;
      if (completed === filesArray.length) {
        finishUploadProcessing(uploads, indicator);
      }
    };
    reader.onerror = function() {
      completed++;
      if (completed === filesArray.length) {
        finishUploadProcessing(uploads, indicator);
      }
    };
    reader.readAsDataURL(file);
  });
}

function finishUploadProcessing(uploads, indicator) {
  if (uploads.length > 0) {
    state.currentUpload = uploads; // Can be a single object or array of objects
    indicator.textContent = `${uploads.length} file terpilih: ` + uploads.map(u => u.name).join(', ');
    showToast('File Berhasil Diunggah', `${uploads.length} berkas siap dilampirkan.`, 'info');
  } else {
    state.currentUpload = null;
    indicator.textContent = 'Tidak ada file valid yang terpilih.';
  }
}

// Setup Rupiah inputs
function setupRupiahInput(inputId) {
  const input = document.getElementById(inputId);
  input.addEventListener('input', (e) => {
    let value = e.target.value.replace(/[^0-9]/g, '');
    if (value) {
      e.target.value = formatRupiahDisplay(value);
    } else {
      e.target.value = '';
    }
  });
}

// Format number to Rupiah string format for display
function formatRupiahDisplay(numberString) {
  let number = parseInt(numberString, 10);
  if (isNaN(number)) return '';
  return number.toLocaleString('id-ID');
}

// Format raw number to display text with prefix "Rp"
function formatRupiah(value) {
  if (value === undefined || value === null) return 'Rp 0';
  return 'Rp ' + parseInt(value, 10).toLocaleString('id-ID');
}

// Parse Rupiah string back to raw number
function parseRupiah(rupiahString) {
  if (!rupiahString) return 0;
  return parseInt(rupiahString.replace(/[^0-9]/g, ''), 10) || 0;
}

// ================= DATABASE (INDEXEDDB) =================
function initIndexedDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    
    request.onerror = (e) => {
      showToast('Gagal Membuka Database', 'Aplikasi berjalan tanpa database lokal.', 'error');
      reject(e);
    };
    
    request.onsuccess = (e) => {
      state.db = e.target.result;
      resolve(state.db);
    };
    
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      
      // Transactions store
      if (!db.objectStoreNames.contains(STORE_TXNS)) {
        db.createObjectStore(STORE_TXNS, { keyPath: 'id' });
      }
      
      // Categories store
      if (!db.objectStoreNames.contains(STORE_CATS)) {
        db.createObjectStore(STORE_CATS, { keyPath: 'id' });
      }
      
      // Sources store
      if (!db.objectStoreNames.contains(STORE_SRCS)) {
        db.createObjectStore(STORE_SRCS, { keyPath: 'id' });
      }
      
      // Settings store
      if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
        db.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
      }

      // Sponsorship History store
      if (!db.objectStoreNames.contains(STORE_SPONSORSHIPS)) {
        db.createObjectStore(STORE_SPONSORSHIPS, { keyPath: 'id' });
      }

      // Utang store
      if (!db.objectStoreNames.contains(STORE_UTANG)) {
        db.createObjectStore(STORE_UTANG, { keyPath: 'id' });
      }

      // Deleted IDs tombstone store (untuk retry hapus ke Google Sheets)
      if (!db.objectStoreNames.contains(STORE_DELETED_IDS)) {
        db.createObjectStore(STORE_DELETED_IDS, { keyPath: 'id' });
      }
    };
  });
}

// Load state values from IndexedDB
async function loadStateFromDB() {
  state.transactions = await getAllFromStore(STORE_TXNS);
  state.categories = await getAllFromStore(STORE_CATS);
  state.sources = await getAllFromStore(STORE_SRCS);
  
  try {
    state.utang = await getAllFromStore(STORE_UTANG);
  } catch (err) {
    state.utang = [];
  }

  if (!state.utang || state.utang.length === 0) {
    try {
      const savedUtang = localStorage.getItem('raimuna_utang_data');
      if (savedUtang) state.utang = JSON.parse(savedUtang);
    } catch (e) {}
  }
  
  try {
    state.sponsorshipHistory = await getAllFromStore(STORE_SPONSORSHIPS);
  } catch (err) {
    state.sponsorshipHistory = [];
  }
  
  if (!state.sponsorshipHistory || state.sponsorshipHistory.length === 0) {
    try {
      const saved = localStorage.getItem('sponsorship_history');
      if (saved) state.sponsorshipHistory = JSON.parse(saved);
    } catch (e) {}
  }
  
  // Seed default categories & sources if empty
  if (state.categories.length === 0) {
    for (const cat of DEFAULT_CATEGORIES) {
      const item = { id: generateUniqueId('CAT'), nama: cat, isDefault: true };
      await saveToStore(STORE_CATS, item);
      state.categories.push(item);
    }
  }
  
  if (state.sources.length === 0) {
    for (const src of DEFAULT_SOURCES) {
      const item = { id: generateUniqueId('SRC'), nama: src, isDefault: true };
      await saveToStore(STORE_SRCS, item);
      state.sources.push(item);
    }
  }

  // Migration check: Ensure required sources ('Pembayaran Tenant', 'Tanpa Sumber Dana (Dana Talangan)') are present
  const requiredSources = ['Pembayaran Tenant', 'Tanpa Sumber Dana (Dana Talangan)'];
  for (const reqSrc of requiredSources) {
    if (!state.sources.some(s => s && s.nama === reqSrc)) {
      const item = { id: generateUniqueId('SRC'), nama: reqSrc, isDefault: true };
      await saveToStore(STORE_SRCS, item);
      state.sources.push(item);
    }
  }

  // Rename any existing 'Pembayaran Stand' source entry to 'Pembayaran Tenant'
  const oldStandSrc = state.sources.find(s => s && s.nama === 'Pembayaran Stand');
  if (oldStandSrc) {
    oldStandSrc.nama = 'Pembayaran Tenant';
    await saveToStore(STORE_SRCS, oldStandSrc);
  }
  
  // Load settings
  const sheetUrlSetting = await getFromStore(STORE_SETTINGS, 'sheetUrl');
  const autoSyncSetting = await getFromStore(STORE_SETTINGS, 'autoSync');
  
  const defaultUrl = 'https://script.google.com/macros/s/AKfycbwG2W4toZtjXFk5UmWt9xemdTqyodjqEOfQzXYEs1uMMNzJdqBWtUhW2o4aJ1-aq4W6pQ/exec';
  state.settings.sheetUrl = defaultUrl;
  await saveToStore(STORE_SETTINGS, { key: 'sheetUrl', value: defaultUrl });
  
  if (autoSyncSetting === null || autoSyncSetting === undefined) {
    state.settings.autoSync = true;
    await saveToStore(STORE_SETTINGS, { key: 'autoSync', value: true });
  } else {
    state.settings.autoSync = autoSyncSetting.value;
  }
  
  // Populate settings form fields
  document.getElementById('settings-sheet-url').value = state.settings.sheetUrl;
  document.getElementById('settings-auto-sync').checked = state.settings.autoSync;
}

// Database helper operations
function getAllFromStore(storeName) {
  return new Promise((resolve) => {
    if (!state.db) return resolve([]);
    const transaction = state.db.transaction(storeName, 'readonly');
    const store = transaction.objectStore(transaction.objectStoreNames[0] || storeName);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => resolve([]);
  });
}

function getFromStore(storeName, key) {
  return new Promise((resolve) => {
    if (!state.db) return resolve(null);
    const transaction = state.db.transaction(storeName, 'readonly');
    const store = transaction.objectStore(storeName);
    const request = store.get(key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => resolve(null);
  });
}

function saveToStore(storeName, item) {
  return new Promise((resolve, reject) => {
    if (!state.db) return resolve();
    const transaction = state.db.transaction(storeName, 'readwrite');
    const store = transaction.objectStore(storeName);
    const request = store.put(item);
    request.onsuccess = () => resolve();
    request.onerror = (e) => reject(e);
  });
}

function deleteFromStore(storeName, key) {
  return new Promise((resolve, reject) => {
    if (!state.db) return resolve();
    const transaction = state.db.transaction(storeName, 'readwrite');
    const store = transaction.objectStore(storeName);
    const request = store.delete(key);
    request.onsuccess = () => resolve();
    request.onerror = (e) => reject(e);
  });
}

function clearStore(storeName) {
  return new Promise((resolve, reject) => {
    if (!state.db) return resolve();
    const transaction = state.db.transaction(storeName, 'readwrite');
    const store = transaction.objectStore(storeName);
    const request = store.clear();
    request.onsuccess = () => resolve();
    request.onerror = (e) => reject(e);
  });
}

// Generate unique ID with prefix
function generateUniqueId(prefix) {
  const dateStr = new Date().toISOString().slice(0,10).replace(/-/g, '');
  const randomChars = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `${prefix}-${dateStr}-${randomChars}`;
}

// ================= NAVIGATION LOGIC =================
function setupNavigation() {
  const links = document.querySelectorAll('.sidebar-nav .nav-link, .nav-link-btn');
  
  links.forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const targetSectionId = link.getAttribute('data-target');
      
      // Update sidebar active link states
      document.querySelectorAll('.sidebar-nav .nav-link').forEach(nav => {
        if (nav.getAttribute('data-target') === targetSectionId) {
          nav.classList.add('active');
        } else {
          nav.classList.remove('active');
        }
      });
      
      // Switch active section with fade animation
      document.querySelectorAll('.content-section').forEach(sec => {
        sec.classList.remove('active');
      });
      document.getElementById(targetSectionId).classList.add('active');
      
      // Update page title
      const titles = {
        'dashboard-section': 'Dashboard Keuangan',
        'pemasukan-section': 'Pencatatan Pemasukan',
        'pengeluaran-section': 'Pencatatan Pengeluaran',
        'kategori-section': 'Manajemen Kategori',
        'utang-section': 'Pencatatan Utang',
        'laporan-section': 'Laporan Keuangan',
        'sponsorship-section': 'Cetak Nota Sponsorship',
        'pengaturan-section': 'Integrasi Google Sheets'
      };
      document.getElementById('page-title').textContent = titles[targetSectionId] || 'Keuangan Raimuna';
      
      // Close mobile sidebar on navigation
      document.querySelector('.sidebar').classList.remove('open');
      
      // Trigger section-specific renders
      if (targetSectionId === 'dashboard-section') {
        renderDashboard();
      } else if (targetSectionId === 'laporan-section') {
        renderLaporan();
      } else if (targetSectionId === 'kategori-section') {
        renderKategoriPage();
      } else if (targetSectionId === 'utang-section') {
        renderUtangPage();
      } else if (targetSectionId === 'sponsorship-section') {
        renderSponsorshipSection();
      } else if (targetSectionId === 'pemasukan-section' || targetSectionId === 'pengeluaran-section') {
        populateDropdowns();
      }
    });
  });
}

// ================= DROPDOWN POPULATOR =================
function populateDropdowns() {
  const inSumberSelect = document.getElementById('in-sumber');
  const outKategoriSelect = document.getElementById('out-kategori');
  const outSumberSelect = document.getElementById('out-sumber');
  const filterKategoriSelect = document.getElementById('filter-kategori');
  const filterSumberSelect = document.getElementById('filter-sumber');
  const editKategoriSelect = document.getElementById('edit-kategori');
  const editSumberSelect = document.getElementById('edit-sumber');
  const utangSumberSelect = document.getElementById('utang-sumber-kat');
  const alokasiSumberSelect = document.getElementById('alokasi-sumber-select');
  
  // Keep selected values if any
  const selectedSumber = inSumberSelect ? inSumberSelect.value : '';
  const selectedKategori = outKategoriSelect ? outKategoriSelect.value : '';
  const selectedOutSumber = outSumberSelect ? outSumberSelect.value : '';
  const selectedFilterKategori = filterKategoriSelect ? filterKategoriSelect.value : 'ALL';
  const selectedFilterSumber = filterSumberSelect ? filterSumberSelect.value : 'ALL';
  const selectedEditKat = editKategoriSelect ? editKategoriSelect.value : '';
  const selectedEditSumber = editSumberSelect ? editSumberSelect.value : '';
  const selectedUtangSumber = utangSumberSelect ? utangSumberSelect.value : '';
  const selectedAlokasiSumber = alokasiSumberSelect ? alokasiSumberSelect.value : '';
  
  // Clear
  if (inSumberSelect) inSumberSelect.innerHTML = '<option value="" disabled selected>Pilih Sumber Dana</option>';
  if (outKategoriSelect) outKategoriSelect.innerHTML = '<option value="" disabled selected>Pilih Kategori Bidang</option>';
  if (outSumberSelect) outSumberSelect.innerHTML = '<option value="" disabled selected>Pilih Sumber Dana</option>';
  if (filterKategoriSelect) filterKategoriSelect.innerHTML = '<option value="ALL">Semua Kategori</option>';
  if (filterSumberSelect) filterSumberSelect.innerHTML = '<option value="ALL">Semua Sumber Dana</option>';
  if (editKategoriSelect) editKategoriSelect.innerHTML = '<option value="-">Tanpa Kategori (-)</option>';
  if (editSumberSelect) editSumberSelect.innerHTML = '<option value="" disabled selected>Pilih Sumber Dana</option>';
  if (utangSumberSelect) utangSumberSelect.innerHTML = '<option value="" disabled selected>Pilih Sumber Dana / Kategori</option>';
  if (alokasiSumberSelect) alokasiSumberSelect.innerHTML = '<option value="" disabled selected>Pilih Sumber Dana Resmi</option>';
  
  // Populate Sources
  state.sources.forEach(src => {
    if (inSumberSelect) {
      const opt = document.createElement('option');
      opt.value = src.nama;
      opt.textContent = src.nama;
      inSumberSelect.appendChild(opt);
    }

    if (outSumberSelect) {
      const optOut = document.createElement('option');
      optOut.value = src.nama;
      optOut.textContent = src.nama;
      outSumberSelect.appendChild(optOut);
    }
    
    if (filterSumberSelect) {
      const filterOpt = document.createElement('option');
      filterOpt.value = src.nama;
      filterOpt.textContent = src.nama;
      filterSumberSelect.appendChild(filterOpt);
    }

    if (editSumberSelect) {
      const optEdit = document.createElement('option');
      optEdit.value = src.nama;
      optEdit.textContent = src.nama;
      editSumberSelect.appendChild(optEdit);
    }

    if (utangSumberSelect) {
      const optUtang = document.createElement('option');
      optUtang.value = src.nama;
      optUtang.textContent = src.nama;
      utangSumberSelect.appendChild(optUtang);
    }

    if (alokasiSumberSelect && !src.nama.includes('Dana Talangan')) {
      const optAlokasi = document.createElement('option');
      optAlokasi.value = src.nama;
      optAlokasi.textContent = src.nama;
      alokasiSumberSelect.appendChild(optAlokasi);
    }
  });
  
  // Populate Categories
  state.categories.forEach(cat => {
    if (outKategoriSelect) {
      const opt = document.createElement('option');
      opt.value = cat.nama;
      opt.textContent = cat.nama;
      outKategoriSelect.appendChild(opt);
    }
    
    if (filterKategoriSelect) {
      const filterOpt = document.createElement('option');
      filterOpt.value = cat.nama;
      filterOpt.textContent = cat.nama;
      filterKategoriSelect.appendChild(filterOpt);
    }

    if (editKategoriSelect) {
      const optEdit = document.createElement('option');
      optEdit.value = cat.nama;
      optEdit.textContent = cat.nama;
      editKategoriSelect.appendChild(optEdit);
    }
  });
  
  // Restore selections
  if (selectedSumber && inSumberSelect) inSumberSelect.value = selectedSumber;
  if (selectedKategori && outKategoriSelect) outKategoriSelect.value = selectedKategori;
  if (selectedOutSumber && outSumberSelect) outSumberSelect.value = selectedOutSumber;
  if (selectedFilterKategori && filterKategoriSelect) filterKategoriSelect.value = selectedFilterKategori;
  if (selectedFilterSumber && filterSumberSelect) filterSumberSelect.value = selectedFilterSumber;
  if (selectedEditKat && editKategoriSelect) editKategoriSelect.value = selectedEditKat;
  if (selectedEditSumber && editSumberSelect) editSumberSelect.value = selectedEditSumber;
}

// ================= FORM SUBMISSION HANDLERS =================
function setupFormHandlers() {
  // Pemasukan Form Submit
  const formIn = document.getElementById('form-pemasukan');
  formIn.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const tanggal = document.getElementById('in-tanggal').value;
    const sumber = document.getElementById('in-sumber').value;
    const pemberi = document.getElementById('in-pemberi').value;
    const nominal = parseRupiah(document.getElementById('in-nominal').value);
    const keterangan = document.getElementById('in-keterangan').value;
    
    if (nominal <= 0) {
      showToast('Input Salah', 'Nominal harus lebih besar dari Rp 0.', 'error');
      return;
    }
    
    const newTxn = {
      id: generateUniqueId('TXN-IN'),
      tanggal,
      tipe: 'IN',
      kategori: '-',
      sumberDana: sumber,
      kategoriSumber: sumber,
      pic: pemberi,
      nominal,
      keterangan,
      attachment: state.currentUpload, // Contains {name, type, base64}
      dateCreated: new Date().toISOString(),
      sync: false
    };
    
    await saveTransaction(newTxn);
    
    formIn.reset();
    document.getElementById('in-tanggal').value = new Date().toISOString().split('T')[0];
    fileIndicatorIn.textContent = '';
    state.currentUpload = null;
  });
  
  // Pengeluaran Form Submit
  const formOut = document.getElementById('form-pengeluaran');
  formOut.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const tanggal = document.getElementById('out-tanggal').value;
    const kategori = document.getElementById('out-kategori').value;
    const sumberDana = document.getElementById('out-sumber').value;
    const pengambil = document.getElementById('out-pengambil').value;
    const nominal = parseRupiah(document.getElementById('out-nominal').value);
    const keterangan = document.getElementById('out-keterangan').value;
    
    if (nominal <= 0) {
      showToast('Input Salah', 'Nominal harus lebih besar dari Rp 0.', 'error');
      return;
    }
    
    
    const newTxn = {
      id: generateUniqueId('TXN-OUT'),
      tanggal,
      tipe: 'OUT',
      kategori: kategori,
      sumberDana: sumberDana,
      kategoriSumber: kategori,
      pic: pengambil,
      nominal,
      keterangan,
      attachment: state.currentUpload,
      dateCreated: new Date().toISOString(),
      sync: false
    };
    
    await saveTransaction(newTxn);
    
    formOut.reset();
    document.getElementById('out-tanggal').value = new Date().toISOString().split('T')[0];
    fileIndicatorOut.textContent = '';
    state.currentUpload = null;
  });
}

// Saves a transaction to DB and local memory
async function saveTransaction(txn) {
  state.transactions.push(txn);
  await saveToStore(STORE_TXNS, txn);
  
  // Auto-record to state.utang if OUT transaction is marked as Tanpa Sumber Dana (Dana Talangan)
  const src = getTxSumber(txn);
  if (txn.tipe === 'OUT' && (src.includes('Dana Talangan') || src === 'Tanpa Sumber Dana')) {
    const existingUtang = (state.utang || []).find(u => u.linkedTxId === txn.id);
    if (!existingUtang) {
      const autoUtang = {
        id: generateUniqueId('UTG'),
        tanggal: txn.tanggal,
        tipe: 'OUT',
        nama: txn.pic || 'Pembayar Dana Talangan',
        sumberDana: 'Tanpa Sumber Dana (Dana Talangan)',
        kategori: txn.kategori || 'Dana Talangan',
        nominal: txn.nominal,
        keterangan: `[Dana Talangan Nota] ${txn.keterangan}`,
        status: 'BELUM_LUNAS',
        paidTxId: null,
        linkedTxId: txn.id,
        dateCreated: new Date().toISOString()
      };
      if (!state.utang) state.utang = [];
      state.utang.unshift(autoUtang);
      try { await saveToStore(STORE_UTANG, autoUtang); } catch(e){}
      try { localStorage.setItem('raimuna_utang_data', JSON.stringify(state.utang)); } catch(e){}
      showToast('Masuk ke Catatan Utang', `Transaksi ${txn.id} dicatat sebagai Utang Belum Lunas (Dana Talangan). Saldo Kas Kas tidak berkurang.`, 'info');
    }
  } else {
    showToast('Transaksi Berhasil Disimpan', `Transaksi ${txn.id} tersimpan secara lokal.`, 'success');
  }
  
  // If autoSync enabled, push to Google Sheets (non-blocking, runs in the background)
  if (state.settings.autoSync && state.settings.sheetUrl) {
    syncTransactionToSheets(txn);
  }
  updateSyncBadgeState();
  
  // Render dashboard / tables
  renderApp();
}

// ================= GOOGLE SHEETS SINKRONISASI =================
async function syncTransactionToSheets(txn) {
  if (!state.settings.sheetUrl) return;
  
  // Create a clean payload without attachment for Google Sheets to avoid cells overflow
  const cleanTxn = {
    id: txn.id,
    tanggal: txn.tanggal,
    tipe: txn.tipe,
    kategori: getTxCategory(txn),
    sumberDana: getTxSumber(txn),
    kategoriSumber: txn.kategoriSumber || getTxCategory(txn),
    pic: txn.pic,
    nominal: txn.nominal,
    keterangan: txn.keterangan,
    dateCreated: txn.dateCreated
  };
  
  try {
    const response = await fetch(state.settings.sheetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain'
      },
      body: JSON.stringify({
        action: 'sync_single',
        transaction: cleanTxn
      })
    });
    
    // Since no-cors mode returns an opaque response, we assume it's successful if it doesn't throw.
    // However, if we want actual response code validation, Apps Script must support proper CORS/JSONP.
    // No-cors handles writes perfectly but response is unreadable. That is totally fine for one-way push!
    txn.sync = true;
    await saveToStore(STORE_TXNS, txn);
    updateSyncBadgeState();
    
    // Check if still in transaction list, update sync flag in state
    const match = state.transactions.find(t => t.id === txn.id);
    if (match) match.sync = true;
    
    showToast('Tersinkronisasi', `Transaksi ${txn.id} disinkronkan ke Google Sheet.`, 'success');
  } catch (err) {
    showToast('Gagal Sinkronisasi', 'Gagal mengirim data ke Google Sheets. Disimpan offline.', 'error');
    updateSyncBadge('error', 'Gagal Sinkronisasi');
  }
}

// Delete transaction from Google Sheets dengan tombstone pattern
async function syncDeleteToSheets(txnId) {
  if (!state.settings.sheetUrl) {
    // Simpan ke tombstone jika tidak ada URL (akan dicoba lagi nanti)
    try { await saveToStore(STORE_DELETED_IDS, { id: txnId, type: 'transaction', deletedAt: new Date().toISOString() }); } catch(e){}
    return;
  }
  // Simpan ke tombstone dulu (jaga-jaga jika request gagal)
  try { await saveToStore(STORE_DELETED_IDS, { id: txnId, type: 'transaction', deletedAt: new Date().toISOString() }); } catch(e){}
  try {
    const resp = await fetch(state.settings.sheetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ action: 'delete_single', id: txnId })
    });
    // Jika berhasil, hapus dari tombstone
    try { await deleteFromStore(STORE_DELETED_IDS, txnId); } catch(e){}
  } catch (err) {
    console.error('Gagal hapus dari Sheet, akan dicoba ulang saat startup:', err);
    // Tombstone tetap tersimpan untuk retry berikutnya
  }
}

// Kirim semua pending deletes ke Google Sheets (dipanggil saat startup)
async function pushPendingDeletes() {
  if (!state.settings.sheetUrl) return;
  let pendingDeletes = [];
  try { pendingDeletes = await getAllFromStore(STORE_DELETED_IDS); } catch(e){ return; }
  if (!pendingDeletes || pendingDeletes.length === 0) return;

  for (const item of pendingDeletes) {
    try {
      const action = item.type === 'utang' ? 'delete_utang' :
                     item.type === 'kwitansi' ? 'delete_kwitansi' : 'delete_single';
      await fetch(state.settings.sheetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ action, id: item.id, no: item.no || '' })
      });
      // Berhasil → hapus dari tombstone
      try { await deleteFromStore(STORE_DELETED_IDS, item.id); } catch(e){}
    } catch (err) {
      console.error('Gagal push pending delete:', item.id, err);
    }
  }
}

// Push all local transactions to sheets (Bulk)
async function pushAllTransactionsToSheets() {
  if (!state.settings.sheetUrl) {
    showToast('Peringatan', 'Silakan simpan URL Google Sheets terlebih dahulu.', 'error');
    return;
  }
  
  updateSyncBadge('unsynced', 'Mengirim data...');
  showToast('Memulai Sinkronisasi', 'Mengunggah seluruh data lokal ke Google Sheet...', 'info');
  
  const cleanList = state.transactions.map(txn => ({
    id: txn.id,
    tanggal: txn.tanggal,
    tipe: txn.tipe,
    kategori: getTxCategory(txn),
    sumberDana: getTxSumber(txn),
    kategoriSumber: txn.kategoriSumber || getTxCategory(txn),
    pic: txn.pic,
    nominal: txn.nominal,
    keterangan: txn.keterangan,
    dateCreated: txn.dateCreated
  }));
  
  try {
    // We can try to use a standard CORS POST if Apps Script is configured for it,
    // otherwise fallback to no-cors. For bulk push, let's use no-cors to be safe.
    await fetch(state.settings.sheetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain'
      },
      body: JSON.stringify({
        action: 'push_bulk',
        transactions: cleanList,
        kwitansi: state.sponsorshipHistory || [],
        utang: state.utang || []
      })
    });
    
    // Mark all as synced
    for (let txn of state.transactions) {
      txn.sync = true;
      await saveToStore(STORE_TXNS, txn);
    }
    
    updateSyncBadgeState();
    renderApp();
    showToast('Ekspor Berhasil', 'Seluruh data transaksi terkirim ke Google Sheets.', 'success');
  } catch (err) {
    showToast('Gagal Mengirim Data', 'Terjadi kesalahan jaringan atau CORS.', 'error');
    updateSyncBadge('error', 'Gagal Sinkronisasi');
  }
}

// Pull all transactions from Google Sheets
async function pullAllTransactionsFromSheets() {
  if (!state.settings.sheetUrl) {
    showToast('Peringatan', 'Silakan simpan URL Google Sheets terlebih dahulu.', 'error');
    return;
  }
  
  if (!confirm('Peringatan! Menarik data dari Google Sheets akan MENGHAPUS seluruh data transaksi lokal saat ini dan menimpanya dengan data dari sheet. Lanjutkan?')) {
    return;
  }
  
  updateSyncBadge('unsynced', 'Menarik data...');
  showToast('Mengimpor Data', 'Mengunduh data transaksi dari Google Sheets...', 'info');
  
  try {
    // GET requests usually follow CORS. In Google Apps Script, redirecting makes it tricky.
    // Let's fetch using standard CORS since GET usually responds with access-control-allow-origin header.
    const response = await fetch(state.settings.sheetUrl);
    const result = await response.json();
    
    if (result.success && Array.isArray(result.data)) {
      // Simpan semua attachment lokal sebelum diganti (nota/bukti tidak disimpan di Sheets)
      const localAttachmentMap = {};
      for (const txn of state.transactions) {
        if (txn.attachment && txn.id) {
          localAttachmentMap[txn.id] = txn.attachment;
        }
      }
      
      // Clear local txns store
      await clearStore(STORE_TXNS);
      
      const newTxns = result.data.map(parseSheetRow);
      
      // Kembalikan attachment lokal ke transaksi yang sesuai berdasarkan ID
      for (const txn of newTxns) {
        if (localAttachmentMap[txn.id]) {
          txn.attachment = localAttachmentMap[txn.id];
        }
      }
      
      // Save all to local DB
      for (const txn of newTxns) {
        await saveToStore(STORE_TXNS, txn);
      }

      if (result.kwitansi && Array.isArray(result.kwitansi) && result.kwitansi.length > 0) {
        const parsedKw = result.kwitansi.map(parseKwitansiRow).filter(Boolean);
        state.sponsorshipHistory = parsedKw;
        try {
          await clearStore(STORE_SPONSORSHIPS);
          for (const kw of parsedKw) {
            await saveToStore(STORE_SPONSORSHIPS, kw);
          }
          localStorage.setItem('sponsorship_history', JSON.stringify(state.sponsorshipHistory));
        } catch(e){}
      }

      if (result.utang && Array.isArray(result.utang) && result.utang.length > 0) {
        const parsedUt = result.utang.map(parseUtangRow).filter(Boolean);
        state.utang = parsedUt;
        try {
          await clearStore(STORE_UTANG);
          for (const ut of parsedUt) {
            await saveToStore(STORE_UTANG, ut);
          }
          localStorage.setItem('raimuna_utang_data', JSON.stringify(state.utang));
        } catch(e){}
      }
      
      state.transactions = newTxns;
      updateSyncBadgeState();
      renderApp();
      showToast('Impor Berhasil', `Berhasil memuat ${newTxns.length} transaksi dari Google Sheets.`, 'success');
    } else {
      showToast('Gagal Impor', 'Format data tidak sesuai atau sheet kosong.', 'error');
      updateSyncBadgeState();
    }
  } catch (err) {
    showToast('Gagal Mengambil Data', 'Pastikan Apps Script telah di-deploy dan URL benar.', 'error');
    updateSyncBadgeState();
  }
}

// Auto-pull dari Google Sheets saat startup (FULL REPLACE - Google Sheets = sumber kebenaran tunggal)
// Catatan: pushPendingDeletes() dan autoSyncPendingTransactions() HARUS dipanggil SEBELUM fungsi ini
async function autoPullFromSheets() {
  if (!state.settings.sheetUrl) return;
  
  updateSyncBadge('unsynced', 'Menarik data...');
  try {
    const response = await fetch(state.settings.sheetUrl);
    const result = await response.json();
    
    if (result.success && Array.isArray(result.data)) {
      // ===== FULL REPLACE: Google Sheets adalah sumber kebenaran =====
      // Semua data lokal diganti dengan data dari Sheet
      // (pushPendingDeletes & autoSyncPendingTransactions sudah jalan sebelumnya,
      //  jadi data Sheet sudah akurat mencerminkan semua aksi hapus/tambah lokal)
      
      // Simpan semua attachment lokal sebelum diganti (nota/bukti tidak disimpan di Sheets)
      const localAttachmentMap = {};
      for (const txn of state.transactions) {
        if (txn.attachment && txn.id) {
          localAttachmentMap[txn.id] = txn.attachment;
        }
      }
      
      const remoteTxns = result.data.map(parseSheetRow);
      
      // Kembalikan attachment lokal ke transaksi yang sesuai berdasarkan ID
      for (const txn of remoteTxns) {
        if (localAttachmentMap[txn.id]) {
          txn.attachment = localAttachmentMap[txn.id];
        }
      }
      
      // Ganti data transaksi lokal sepenuhnya
      await clearStore(STORE_TXNS);
      for (const txn of remoteTxns) {
        await saveToStore(STORE_TXNS, txn);
      }
      state.transactions = remoteTxns;
      
      // Ganti data kwitansi/sponsorship sepenuhnya
      if (result.kwitansi && Array.isArray(result.kwitansi)) {
        const parsedKw = result.kwitansi.map(parseKwitansiRow).filter(Boolean);
        state.sponsorshipHistory = parsedKw;
        try {
          await clearStore(STORE_SPONSORSHIPS);
          for (const kw of parsedKw) {
            await saveToStore(STORE_SPONSORSHIPS, kw);
          }
          localStorage.setItem('sponsorship_history', JSON.stringify(state.sponsorshipHistory));
        } catch(e){}
      }

      // Ganti data utang sepenuhnya
      if (result.utang && Array.isArray(result.utang)) {
        const parsedUt = result.utang.map(parseUtangRow).filter(Boolean);
        state.utang = parsedUt;
        try {
          await clearStore(STORE_UTANG);
          for (const ut of parsedUt) {
            await saveToStore(STORE_UTANG, ut);
          }
          localStorage.setItem('raimuna_utang_data', JSON.stringify(state.utang));
        } catch(e){}
      }

      updateSyncBadgeState();
      renderApp();
    } else {
      updateSyncBadgeState();
    }
  } catch (err) {
    console.error('Auto pull failed:', err);
    updateSyncBadgeState();
  }
}

// Automatically sync any pending unsynced transactions in background
async function autoSyncPendingTransactions() {
  if (!state.settings.sheetUrl || !state.settings.autoSync) return;
  const unsynced = state.transactions.filter(t => !t.sync);
  if (unsynced.length === 0) return;
  
  for (const txn of unsynced) {
    await syncTransactionToSheets(txn);
  }
}

// Automatically sync when back online
window.addEventListener('online', async () => {
  await pushPendingDeletes();      // Kirim pending deletes ke Sheet
  await autoSyncPendingTransactions(); // Kirim transaksi baru yang belum tersync
});


// Formats spreadsheet dates cleanly
function formatDateString(val) {
  if (!val) return '';
  // Check if standard date ISO string or similar
  try {
    const d = new Date(val);
    if (!isNaN(d.getTime())) {
      return d.toISOString().split('T')[0];
    }
  } catch(e){}
  return String(val).split('T')[0];
}

// Test connection to Apps Script Web App URL
async function testGoogleSheetsConnection(showSuccessToast = true) {
  if (!state.settings.sheetUrl) {
    showToast('Error', 'Input URL kosong.', 'error');
    return;
  }
  
  try {
    // Test connection via POST test action using CORS.
    // If it fails with CORS, we'll try a CORS-enabled get or just notify
    const res = await fetch(state.settings.sheetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ action: 'test' })
    });
    
    // Web Apps redirect with 302, response might not be fetchable with CORS depending on Google setup,
    // so we handle normal errors or successes.
    if (showSuccessToast) {
      showToast('Koneksi Berhasil!', 'Google Sheets terhubung dengan sempurna.', 'success');
    }
    updateSyncBadgeState();
  } catch (err) {
    // If it fails because of CORS but still reached it, we might get an opaque error
    // In many cases, it still works. Let's make a friendly message.
    if (showSuccessToast) {
      showToast('Koneksi Diuji', 'Aplikasi mencoba tersambung. Pastikan deploy Apps Script benar.', 'info');
    }
    updateSyncBadgeState();
  }
}

// Update UI Sync Badge based on current sync states
function updateSyncBadgeState() {
  if (!state.settings.sheetUrl) {
    updateSyncBadge('unsynced', 'Offline / Tidak Sinkron');
    return;
  }
  
  const unsyncedCount = state.transactions.filter(t => !t.sync).length;
  
  if (unsyncedCount > 0) {
    updateSyncBadge('unsynced', `${unsyncedCount} Transaksi Belum Sinkron`);
  } else {
    updateSyncBadge('synced', 'Tersinkronisasi');
  }
}

function updateSyncBadge(type, text) {
  const badge = document.getElementById('sync-status-badge');
  const textEl = badge.querySelector('.badge-text');
  
  badge.className = `sync-badge ${type}`;
  textEl.textContent = text;
}

// ================= STATE RENDERER =================
function renderApp() {
  populateDropdowns();
  updateSyncBadgeState();
  
  // Check active section and render it
  const activeSec = document.querySelector('.content-section.active');
  if (activeSec) {
    const id = activeSec.getAttribute('id');
    if (id === 'dashboard-section') renderDashboard();
    else if (id === 'laporan-section') renderLaporan();
    else if (id === 'kategori-section') renderKategoriPage();
    else if (id === 'sponsorship-section') renderSponsorshipSection();
    else if (id === 'utang-section') renderUtangPage();
  }
}

// ================= RENDER: DASHBOARD =================
function renderDashboard() {
  // 1. Calculate Metrics
  let totalIn = 0;
  let totalOutKas = 0; // Kas keluar dari Sumber Dana resmi
  let totalOutAll = 0; // Total pengeluaran termasuk Dana Talangan
  let txnCount = (state.transactions || []).length;
  
  (state.transactions || []).forEach(t => {
    const nom = parseInt(t.nominal, 10) || 0;
    if (t.tipe === 'IN') {
      totalIn += nom;
    } else if (t.tipe === 'OUT') {
      totalOutAll += nom;
      const src = String(getTxSumber(t) || '');
      const isTalangan = src.includes('Dana Talangan') || src.includes('Tanpa Sumber Dana');
      if (!isTalangan) {
        totalOutKas += nom;
      }
    }
  });
  
  // Saldo Kas HANYA dikurangi oleh pengeluaran dari Sumber Dana Resmi (kas keluar)
  let saldo = Math.max(0, totalIn - totalOutKas);

  let totalUtangPending = 0;
  (state.utang || []).forEach(u => {
    if (u.status === 'BELUM_LUNAS') totalUtangPending += (parseInt(u.nominal, 10) || 0);
  });

  let totalTalanganPending = 0;
  (state.transactions || []).forEach(t => {
    const src = String(getTxSumber(t) || '');
    if (t.tipe === 'OUT' && (src.includes('Dana Talangan') || src.includes('Tanpa Sumber Dana'))) {
      totalTalanganPending += (parseInt(t.nominal, 10) || 0);
    }
  });
  
  // Update fields
  if (document.getElementById('dashboard-total-saldo')) document.getElementById('dashboard-total-saldo').textContent = formatRupiah(saldo);
  if (document.getElementById('dashboard-total-pemasukan')) document.getElementById('dashboard-total-pemasukan').textContent = formatRupiah(totalIn);
  if (document.getElementById('dashboard-total-pengeluaran')) document.getElementById('dashboard-total-pengeluaran').textContent = formatRupiah(totalOutKas);
  if (document.getElementById('dashboard-total-transaksi')) document.getElementById('dashboard-total-transaksi').textContent = txnCount;
  if (document.getElementById('dashboard-total-utang-pending')) document.getElementById('dashboard-total-utang-pending').textContent = formatRupiah(totalUtangPending);
  if (document.getElementById('dashboard-total-talangan-pending')) document.getElementById('dashboard-total-talangan-pending').textContent = formatRupiah(totalTalanganPending);

  // Render Dashboard Quick Checklist Utang
  renderDashboardQuickUtang();
  
  // 1b. Render Ringkasan Saldo per Sumber Dana
  const summaryTbody = document.getElementById('dashboard-sumber-summary-tbody');
  if (summaryTbody) {
    summaryTbody.innerHTML = '';
    
    // Group transactions by Sumber Dana
    const sourceSummaries = {};
    // Seed with all current sources in state
    (state.sources || []).forEach(src => {
      if (src && src.nama) {
        sourceSummaries[src.nama] = { pemasukan: 0, pengeluaran: 0 };
      }
    });
    
    // Process transactions
    (state.transactions || []).forEach(t => {
      const src = getTxSumber(t);
      const targetSrc = (src && src !== '-') ? src : 'Tanpa Sumber Dana';
      if (!sourceSummaries[targetSrc]) {
        sourceSummaries[targetSrc] = { pemasukan: 0, pengeluaran: 0 };
      }
      const nom = parseInt(t.nominal, 10) || 0;
      if (t.tipe === 'IN') {
        sourceSummaries[targetSrc].pemasukan += nom;
      } else if (t.tipe === 'OUT') {
        sourceSummaries[targetSrc].pengeluaran += nom;
      }
    });
    
    const summaryKeys = Object.keys(sourceSummaries).sort();
    if (summaryKeys.length === 0) {
      summaryTbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted">Belum ada data sumber dana terdaftar.</td></tr>';
    } else {
      summaryKeys.forEach(srcName => {
        const data = sourceSummaries[srcName];
        const rawSisa = data.pemasukan - data.pengeluaran;
        const sisa = Math.max(0, rawSisa);
        
        // Only show if there's any transaction or it's a default source to keep UI clean
        if (data.pemasukan > 0 || data.pengeluaran > 0) {
          const tr = document.createElement('tr');
          tr.innerHTML = `
            <td class="font-bold">${srcName}</td>
            <td class="text-right text-success font-bold">${formatRupiah(data.pemasukan)}</td>
            <td class="text-right text-danger font-bold">${formatRupiah(data.pengeluaran)}</td>
            <td class="text-right font-bold ${sisa > 0 ? 'text-success' : 'text-muted'}">${formatRupiah(sisa)}</td>
          `;
          summaryTbody.appendChild(tr);
        }
      });
      
      // If no active rows were appended (all are zero), show a message
      if (summaryTbody.innerHTML === '') {
        summaryTbody.innerHTML = '<tr><td colspan="4" class="text-center text-muted">Belum ada transaksi pada sumber dana yang terdaftar.</td></tr>';
      }
    }
  }
  
  // 2. Render 10 Latest Transactions
  const sortedTxns = [...state.transactions].sort((a, b) => new Date(b.tanggal) - new Date(a.tanggal));
  const latestTxns = sortedTxns.slice(0, 10);
  const tbody = document.getElementById('recent-transactions-tbody');
  
  tbody.innerHTML = '';
  if (latestTxns.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="text-center text-muted">Belum ada transaksi terdaftar.</td></tr>';
  } else {
    latestTxns.forEach(tx => {
      const tr = document.createElement('tr');
      tr.addEventListener('click', () => showTransactionDetail(tx));
      
      const typeBadge = tx.tipe === 'IN' 
        ? '<span class="badge-type in">Pemasukan</span>' 
        : '<span class="badge-type out">Pengeluaran</span>';
      
      const syncBadge = tx.sync 
        ? '<span class="badge-sync synced" title="Tersinkronisasi">☁️</span>' 
        : '<span class="badge-sync unsynced" title="Belum disinkronkan">⏳</span>';
        
      tr.innerHTML = `
        <td>${formatIndonesianDate(tx.tanggal)}</td>
        <td class="font-bold">${tx.id}</td>
        <td>${typeBadge}</td>
        <td>${getTxCategory(tx)}</td>
        <td>${getTxSumber(tx)}</td>
        <td>${tx.pic}</td>
        <td class="text-right font-bold ${tx.tipe === 'IN' ? 'text-success' : 'text-danger'}">${formatRupiah(tx.nominal)}</td>
        <td class="no-print text-center">${syncBadge}</td>
        <td class="no-print text-center" style="white-space: nowrap;">
          <button class="btn-icon btn-edit-action" title="Edit Transaksi" style="margin-right: 4px;">✏️</button>
          <button class="btn-icon btn-view-action" title="Lihat Detail">🔍</button>
        </td>
      `;
      
      const editBtn = tr.querySelector('.btn-edit-action');
      if (editBtn) {
        editBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          openEditModal(tx);
        });
      }
      const viewBtn = tr.querySelector('.btn-view-action');
      if (viewBtn) {
        viewBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          showTransactionDetail(tx);
        });
      }
      tbody.appendChild(tr);
    });
  }
  
  // 3. Render Dashboard Charts
  renderDashboardCharts();
}

// ================= RENDER: CHARTS =================
function renderDashboardCharts() {
  const ctxFlow = document.getElementById('flowChart').getContext('2d');
  const ctxCat = document.getElementById('categoryChart').getContext('2d');
  
  // Destroy old charts if they exist to prevent memory leaks
  if (state.charts.flow) state.charts.flow.destroy();
  if (state.charts.category) state.charts.category.destroy();
  
  // 1. Process data for Flow Chart (Income vs Expense monthly)
  // Group transactions by month
  const monthlyData = {};
  state.transactions.forEach(t => {
    const monthKey = t.tanggal.slice(0, 7); // YYYY-MM
    if (!monthlyData[monthKey]) {
      monthlyData[monthKey] = { in: 0, out: 0 };
    }
    if (t.tipe === 'IN') monthlyData[monthKey].in += t.nominal;
    else monthlyData[monthKey].out += t.nominal;
  });
  
  // Sort months
  const sortedMonths = Object.keys(monthlyData).sort();
  // If no transactions, add current month as empty placeholder
  if (sortedMonths.length === 0) {
    const currentMonth = new Date().toISOString().slice(0, 7);
    sortedMonths.push(currentMonth);
    monthlyData[currentMonth] = { in: 0, out: 0 };
  }
  
  const labelsFlow = sortedMonths.map(m => {
    const [y, mm] = m.split('-');
    const monthNames = [
      'Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 
      'Jul', 'Agt', 'Sep', 'Okt', 'Nov', 'Des'
    ];
    return `${monthNames[parseInt(mm, 10)-1]} ${y}`;
  });
  
  const dataIn = sortedMonths.map(m => monthlyData[m].in);
  const dataOut = sortedMonths.map(m => monthlyData[m].out);
  
  state.charts.flow = new Chart(ctxFlow, {
    type: 'bar',
    data: {
      labels: labelsFlow,
      datasets: [
        {
          label: 'Pemasukan',
          data: dataIn,
          backgroundColor: 'rgba(78, 189, 122, 0.6)', // Pastel Mint Green
          borderColor: '#4ebd7a',
          borderWidth: 2,
          borderRadius: 8
        },
        {
          label: 'Pengeluaran',
          data: dataOut,
          backgroundColor: 'rgba(254, 226, 226, 0.9)', // Pastel Soft Red
          borderColor: '#fca5a5',
          borderWidth: 2,
          borderRadius: 8
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: {
          position: 'top',
          labels: { font: { family: 'Quicksand', weight: 'bold' } }
        }
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: {
            callback: (value) => 'Rp ' + value.toLocaleString('id-ID'),
            font: { family: 'Quicksand' }
          }
        },
        x: {
          ticks: { font: { family: 'Quicksand' } }
        }
      }
    }
  });
  
  // 2. Process data for Category Chart (Expenses only)
  const categoryTotals = {};
  state.transactions.forEach(t => {
    if (t.tipe === 'OUT') {
      const cat = getTxCategory(t);
      categoryTotals[cat] = (categoryTotals[cat] || 0) + t.nominal;
    }
  });
  
  const labelsCat = Object.keys(categoryTotals);
  const dataCat = Object.values(categoryTotals);
  
  if (labelsCat.length === 0) {
    // Show empty placeholder
    state.charts.category = new Chart(ctxCat, {
      type: 'doughnut',
      data: {
        labels: ['Belum ada Pengeluaran'],
        datasets: [{
          data: [1],
          backgroundColor: ['#f1ebd9'],
          borderWidth: 0
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { position: 'bottom', labels: { font: { family: 'Quicksand' } } },
          tooltip: { enabled: false }
        }
      }
    });
  } else {
    // Generate beautiful pastel colors list
    const backgroundColors = labelsCat.map((_, i) => PASTEL_PALETTE[i % PASTEL_PALETTE.length]);
    
    state.charts.category = new Chart(ctxCat, {
      type: 'doughnut',
      data: {
        labels: labelsCat,
        datasets: [{
          data: dataCat,
          backgroundColor: backgroundColors,
          borderColor: '#ffffff',
          borderWidth: 3
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'bottom',
            labels: { font: { family: 'Quicksand', weight: 'bold' } }
          },
          tooltip: {
            callbacks: {
              label: function(context) {
                let label = context.label || '';
                if (label) label += ': ';
                label += formatRupiah(context.raw);
                return label;
              }
            }
          }
        }
      }
    });
  }
}

// ================= RENDER: LAPORAN =================
function renderLaporan() {
  // Populate filter year options dynamically based on transaction dates
  populateFilterYears();
  
  // Apply Filter & Search logic
  const filtered = filterTransactions();
  
  // Sort transactions by date/amount
  sortTransactions(filtered);
  
  // Compute running balances
  // We need to calculate running balance chronologically (sorted by Date ascending)
  const chronological = [...state.transactions].sort((a,b) => new Date(a.tanggal) - new Date(b.tanggal));
  let runningTotal = 0;
  const runningBalancesMap = {};
  
  chronological.forEach(tx => {
    if (tx.tipe === 'IN') runningTotal += tx.nominal;
    else runningTotal -= tx.nominal;
    runningBalancesMap[tx.id] = Math.max(0, runningTotal);
  });
  
  // Render report rows
  const tbody = document.getElementById('laporan-tbody');
  tbody.innerHTML = '';
  
  let filteredNominalSum = 0;
  
  if (filtered.length === 0) {
    tbody.innerHTML = '<tr class="row-empty"><td colspan="12" class="text-center text-muted">Tidak ditemukan transaksi yang cocok dengan filter.</td></tr>';
    document.getElementById('report-filtered-nominal-sum').textContent = formatRupiah(0);
    document.getElementById('report-filtered-final-saldo').textContent = formatRupiah(0);
  } else {
    filtered.forEach((tx, index) => {
      filteredNominalSum += tx.nominal;
      
      const tr = document.createElement('tr');
      tr.addEventListener('click', () => showTransactionDetail(tx));
      
      const typeBadge = tx.tipe === 'IN' 
        ? '<span class="badge-type in">Pemasukan</span>' 
        : '<span class="badge-type out">Pengeluaran</span>';
      
      const syncBadge = tx.sync 
        ? '<span class="badge-sync synced" title="Tersinkronisasi">☁️</span>' 
        : '<span class="badge-sync unsynced" title="Belum disinkronkan">⏳</span>';
      
      // Obtain running balance at this transaction
      const balAtTx = runningBalancesMap[tx.id] || 0;
      
      tr.innerHTML = `
        <td>${index + 1}</td>
        <td>${formatIndonesianDate(tx.tanggal)}</td>
        <td class="font-bold">${tx.id}</td>
        <td>${typeBadge}</td>
        <td>${getTxCategory(tx)}</td>
        <td>${getTxSumber(tx)}</td>
        <td>${tx.pic}</td>
        <td class="text-muted">${tx.keterangan}</td>
        <td class="text-right font-bold ${tx.tipe === 'IN' ? 'text-success' : 'text-danger'}">${formatRupiah(tx.nominal)}</td>
        <td class="text-right font-bold">${formatRupiah(balAtTx)}</td>
        <td class="no-print text-center">${syncBadge}</td>
        <td class="no-print text-center" style="white-space: nowrap;">
          <button class="btn-icon btn-edit-action" title="Edit Transaksi" style="margin-right: 4px;">✏️</button>
          <button class="btn-icon btn-view-action" title="Lihat Detail">🔍</button>
        </td>
      `;
      
      const editBtn = tr.querySelector('.btn-edit-action');
      if (editBtn) {
        editBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          openEditModal(tx);
        });
      }
      const viewBtn = tr.querySelector('.btn-view-action');
      if (viewBtn) {
        viewBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          showTransactionDetail(tx);
        });
      }
      tbody.appendChild(tr);
    });
    
    // Display total summary for filtered list
    // Use the actual current running balance of the very last chronologically filtered transaction
    // Or let's calculate final total from complete dataset
    let overallIn = 0;
    let overallOut = 0;
    state.transactions.forEach(t => {
      if (t.tipe === 'IN') overallIn += t.nominal;
      else overallOut += t.nominal;
    });
    
    document.getElementById('report-filtered-nominal-sum').textContent = formatRupiah(filteredNominalSum);
    document.getElementById('report-filtered-final-saldo').textContent = formatRupiah(Math.max(0, overallIn - overallOut));
  }
}

// Setup reporting date fields dynamically
function populateFilterYears() {
  const select = document.getElementById('filter-tahun');
  const selectedYear = select.value;
  
  // Extract years from dates
  const years = new Set();
  state.transactions.forEach(tx => {
    if (tx.tanggal) {
      const y = tx.tanggal.slice(0,4);
      years.add(y);
    }
  });
  
  // Also add current year
  years.add(new Date().getFullYear().toString());
  
  select.innerHTML = '<option value="ALL">Semua Tahun</option>';
  Array.from(years).sort().forEach(y => {
    const opt = document.createElement('option');
    opt.value = y;
    opt.textContent = y;
    select.appendChild(opt);
  });
  
  if (selectedYear) select.value = selectedYear;
}

// Filter transaction array based on filter criteria
function filterTransactions() {
  return state.transactions.filter(tx => {
    // 1. Search text (ID, PIC, Keterangan)
    if (state.filters.search) {
      const search = state.filters.search.toLowerCase();
      const matchId = tx.id.toLowerCase().includes(search);
      const matchPic = tx.pic.toLowerCase().includes(search);
      const matchDesc = tx.keterangan.toLowerCase().includes(search);
      if (!matchId && !matchPic && !matchDesc) return false;
    }
    
    // 2. Tipe
    if (state.filters.tipe !== 'ALL' && tx.tipe !== state.filters.tipe) {
      return false;
    }
    
    // 3. Bulan & Tahun
    const [ty, tm] = tx.tanggal.split('-');
    if (state.filters.bulan !== 'ALL' && tm !== state.filters.bulan) return false;
    if (state.filters.tahun !== 'ALL' && ty !== state.filters.tahun) return false;
    
    // 4. Kategori Pengeluaran
    if (state.filters.kategori !== 'ALL' && getTxCategory(tx) !== state.filters.kategori) {
      return false;
    }

    // 5. Sumber Dana
    if (state.filters.sumberDana !== 'ALL' && getTxSumber(tx) !== state.filters.sumberDana) {
      return false;
    }
    
    // 5. Sync Status
    if (state.filters.sync !== 'ALL') {
      const isSynced = tx.sync;
      if (state.filters.sync === 'SYNCED' && !isSynced) return false;
      if (state.filters.sync === 'UNSYNCED' && isSynced) return false;
    }
    
    return true;
  });
}

// Sort transaction array based on active columns
function sortTransactions(list) {
  list.sort((a, b) => {
    let valA, valB;
    
    if (state.sort.column === 'no') {
      // Index order (we will sort by creation date as fallback)
      valA = a.dateCreated;
      valB = b.dateCreated;
    } else if (state.sort.column === 'tanggal') {
      valA = a.tanggal;
      valB = b.tanggal;
    } else if (state.sort.column === 'nominal') {
      valA = a.nominal;
      valB = b.nominal;
    } else {
      return 0;
    }
    
    if (valA < valB) return state.sort.direction === 'asc' ? -1 : 1;
    if (valA > valB) return state.sort.direction === 'asc' ? 1 : -1;
    return 0;
  });
}

// Format date to local Indonesian display string
function formatIndonesianDate(dateString) {
  if (!dateString) return '--';
  const parts = dateString.split('-');
  if (parts.length !== 3) return dateString;
  
  const d = parts[2];
  const m = parts[1];
  const y = parts[0];
  
  const monthNames = [
    'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
    'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'
  ];
  
  return `${d} ${monthNames[parseInt(m, 10)-1]} ${y}`;
}

// Setup report filters listeners
function setupFilterHandlers() {
  document.getElementById('filter-search').addEventListener('input', (e) => {
    state.filters.search = e.target.value;
    renderLaporan();
  });
  
  document.getElementById('filter-tipe').addEventListener('change', (e) => {
    state.filters.tipe = e.target.value;
    renderLaporan();
  });
  
  document.getElementById('filter-bulan').addEventListener('change', (e) => {
    state.filters.bulan = e.target.value;
    renderLaporan();
  });
  
  document.getElementById('filter-tahun').addEventListener('change', (e) => {
    state.filters.tahun = e.target.value;
    renderLaporan();
  });
  
  const filterKat = document.getElementById('filter-kategori');
  if (filterKat) {
    filterKat.addEventListener('change', (e) => {
      state.filters.kategori = e.target.value;
      renderLaporan();
    });
  }

  const filterSrc = document.getElementById('filter-sumber');
  if (filterSrc) {
    filterSrc.addEventListener('change', (e) => {
      state.filters.sumberDana = e.target.value;
      renderLaporan();
    });
  }
  
  document.getElementById('filter-sync').addEventListener('change', (e) => {
    state.filters.sync = e.target.value;
    renderLaporan();
  });
  
  document.getElementById('btn-reset-filters').addEventListener('click', () => {
    document.getElementById('filter-search').value = '';
    document.getElementById('filter-tipe').value = 'ALL';
    document.getElementById('filter-bulan').value = 'ALL';
    document.getElementById('filter-tahun').value = 'ALL';
    if (document.getElementById('filter-kategori')) document.getElementById('filter-kategori').value = 'ALL';
    if (document.getElementById('filter-sumber')) document.getElementById('filter-sumber').value = 'ALL';
    document.getElementById('filter-sync').value = 'ALL';
    
    state.filters = {
      search: '',
      tipe: 'ALL',
      bulan: 'ALL',
      tahun: 'ALL',
      kategori: 'ALL',
      sumberDana: 'ALL',
      sync: 'ALL'
    };
    
    renderLaporan();
    showToast('Filter Direset', 'Menampilkan seluruh data transaksi.', 'info');
  });
  
  // Table Sorting logic headers click
  const headers = document.querySelectorAll('#table-laporan-keuangan th.sortable');
  headers.forEach(header => {
    header.addEventListener('click', () => {
      const col = header.getAttribute('data-sort');
      
      if (state.sort.column === col) {
        state.sort.direction = state.sort.direction === 'asc' ? 'desc' : 'asc';
      } else {
        state.sort.column = col;
        state.sort.direction = 'asc';
      }
      
      // Update header indicators
      headers.forEach(h => {
        const icon = h.querySelector('.sort-icon');
        if (h.getAttribute('data-sort') === state.sort.column) {
          icon.textContent = state.sort.direction === 'asc' ? '▲' : '▼';
        } else {
          icon.textContent = '';
        }
      });
      
      renderLaporan();
    });
  });
}

// ================= RENDER: KATEGORI LIST =================
function renderKategoriPage() {
  const listCat = document.getElementById('list-kategori-pengeluaran');
  const listSrc = document.getElementById('list-sumber-pemasukan');
  
  listCat.innerHTML = '';
  listSrc.innerHTML = '';
  
  // Render Categories list
  state.categories.forEach(cat => {
    const li = document.createElement('li');
    li.className = `custom-list-item ${cat.isDefault ? 'default' : ''}`;
    
    let actionHtml = '';
    if (cat.isDefault) {
      actionHtml = '<span class="badge-default">Default</span>';
    } else {
      actionHtml = `<button class="btn-icon text-danger btn-delete-cat" data-id="${cat.id}">🗑️</button>`;
    }
    
    li.innerHTML = `
      <span>${cat.nama}</span>
      ${actionHtml}
    `;
    listCat.appendChild(li);
  });
  
  // Render Sources list
  state.sources.forEach(src => {
    const li = document.createElement('li');
    li.className = `custom-list-item ${src.isDefault ? 'default' : ''}`;
    
    let actionHtml = '';
    if (src.isDefault) {
      actionHtml = '<span class="badge-default">Default</span>';
    } else {
      actionHtml = `<button class="btn-icon text-danger btn-delete-src" data-id="${src.id}">🗑️</button>`;
    }
    
    li.innerHTML = `
      <span>${src.nama}</span>
      ${actionHtml}
    `;
    listSrc.appendChild(li);
  });
  
  // Attach delete listeners
  document.querySelectorAll('.btn-delete-cat').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id');
      const cat = state.categories.find(c => c.id === id);
      if (cat && confirm(`Hapus kategori "${cat.nama}"?`)) {
        state.categories = state.categories.filter(c => c.id !== id);
        await deleteFromStore(STORE_CATS, id);
        showToast('Kategori Dihapus', `Kategori "${cat.nama}" berhasil dihapus.`, 'success');
        renderKategoriPage();
      }
    });
  });
  
  document.querySelectorAll('.btn-delete-src').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-id');
      const src = state.sources.find(s => s.id === id);
      if (src && confirm(`Hapus sumber dana "${src.nama}"?`)) {
        state.sources = state.sources.filter(s => s.id !== id);
        await deleteFromStore(STORE_SRCS, id);
        showToast('Sumber Dana Dihapus', `Sumber "${src.nama}" berhasil dihapus.`, 'success');
        renderKategoriPage();
      }
    });
  });
}

// Add Custom items triggers
function setupCustomModals() {
  const inForm = document.getElementById('form-kategori-add');
  const srcForm = document.getElementById('form-sumber-add');
  
  // Page category adder
  inForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const nama = document.getElementById('kategori-nama').value.trim();
    if (nama) {
      // Check duplicate
      if (state.categories.some(c => c.nama.toLowerCase() === nama.toLowerCase())) {
        showToast('Duplikat', 'Kategori ini sudah terdaftar.', 'error');
        return;
      }
      
      const item = { id: generateUniqueId('CAT'), nama, isDefault: false };
      state.categories.push(item);
      await saveToStore(STORE_CATS, item);
      document.getElementById('kategori-nama').value = '';
      showToast('Kategori Ditambahkan', `Kategori "${nama}" berhasil disimpan.`, 'success');
      renderKategoriPage();
    }
  });
  
  srcForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const nama = document.getElementById('sumber-nama').value.trim();
    if (nama) {
      // Check duplicate
      if (state.sources.some(s => s.nama.toLowerCase() === nama.toLowerCase())) {
        showToast('Duplikat', 'Sumber dana ini sudah terdaftar.', 'error');
        return;
      }
      
      const item = { id: generateUniqueId('SRC'), nama, isDefault: false };
      state.sources.push(item);
      await saveToStore(STORE_SRCS, item);
      document.getElementById('sumber-nama').value = '';
      showToast('Sumber Dana Ditambahkan', `Sumber "${nama}" berhasil disimpan.`, 'success');
      renderKategoriPage();
    }
  });
  
  // Inline dropdown buttons (+) triggers
  const customModal = document.getElementById('custom-add-modal');
  const customTitle = document.getElementById('custom-modal-title');
  const customLabel = document.getElementById('custom-modal-label');
  const customInput = document.getElementById('custom-input-value');
  
  let inlineAddTargetType = ''; // 'SUMBER' or 'KATEGORI'
  let triggeredFrom = ''; // 'IN-FORM' or 'OUT-FORM'
  
  document.getElementById('btn-add-sumber-inline').addEventListener('click', () => {
    inlineAddTargetType = 'SUMBER';
    triggeredFrom = 'IN-FORM';
    customTitle.textContent = 'Tambah Sumber Dana';
    customLabel.textContent = 'Nama Sumber Dana Baru';
    customInput.value = '';
    customInput.placeholder = 'Misal: Sponsorship Eksternal';
    customModal.classList.add('open');
  });

  const btnAddSumberOutInline = document.getElementById('btn-add-sumber-out-inline');
  if (btnAddSumberOutInline) {
    btnAddSumberOutInline.addEventListener('click', () => {
      inlineAddTargetType = 'SUMBER';
      triggeredFrom = 'OUT-FORM';
      customTitle.textContent = 'Tambah Sumber Dana';
      customLabel.textContent = 'Nama Sumber Dana Baru';
      customInput.value = '';
      customInput.placeholder = 'Misal: Sponsorship Eksternal';
      customModal.classList.add('open');
    });
  }
  
  document.getElementById('btn-add-kategori-inline').addEventListener('click', () => {
    inlineAddTargetType = 'KATEGORI';
    customTitle.textContent = 'Tambah Kategori Pengeluaran';
    customLabel.textContent = 'Nama Kategori Baru';
    customInput.value = '';
    customInput.placeholder = 'Misal: Bidang Keamanan';
    customModal.classList.add('open');
  });
  
  // Close inline dialogs
  const closeInline = () => customModal.classList.remove('open');
  document.getElementById('btn-close-custom-modal').addEventListener('click', closeInline);
  document.getElementById('btn-cancel-custom-modal').addEventListener('click', closeInline);
  
  // Submit inline custom adder
  document.getElementById('btn-submit-custom-modal').addEventListener('click', async () => {
    const val = customInput.value.trim();
    if (!val) {
      showToast('Input Kosong', 'Harap isi nama item terlebih dahulu.', 'error');
      return;
    }
    
    if (inlineAddTargetType === 'SUMBER') {
      if (state.sources.some(s => s.nama.toLowerCase() === val.toLowerCase())) {
        showToast('Duplikat', 'Sumber dana ini sudah terdaftar.', 'error');
        return;
      }
      const item = { id: generateUniqueId('SRC'), nama: val, isDefault: false };
      state.sources.push(item);
      await saveToStore(STORE_SRCS, item);
      populateDropdowns();
      
      if (triggeredFrom === 'OUT-FORM') {
        const outSumber = document.getElementById('out-sumber');
        if (outSumber) outSumber.value = val;
      } else {
        document.getElementById('in-sumber').value = val;
      }
    } else if (inlineAddTargetType === 'KATEGORI') {
      if (state.categories.some(c => c.nama.toLowerCase() === val.toLowerCase())) {
        showToast('Duplikat', 'Kategori ini sudah terdaftar.', 'error');
        return;
      }
      const item = { id: generateUniqueId('CAT'), nama: val, isDefault: false };
      state.categories.push(item);
      await saveToStore(STORE_CATS, item);
      populateDropdowns();
      document.getElementById('out-kategori').value = val;
    }
    
    closeInline();
    showToast('Berhasil Ditambahkan', `"${val}" siap digunakan.`, 'success');
  });
}

// ================= DETAIL MODAL LOGIC =================
function showTransactionDetail(txn) {
  const modal = document.getElementById('detail-modal');
  
  // Header details
  document.getElementById('detail-txn-id').textContent = txn.id;
  const typeEl = document.getElementById('detail-txn-type');
  
  if (txn.tipe === 'IN') {
    typeEl.textContent = 'Pemasukan';
    typeEl.className = 'txn-badge-type pemasukan';
    document.getElementById('detail-cat-sumber-label').textContent = 'Sumber Dana:';
    document.getElementById('detail-pic-label').textContent = 'Penanggung Jawab / Pemberi:';
    document.getElementById('detail-amount').className = 'detail-value font-bold text-success';
    
    const srcFundContainer = document.getElementById('detail-source-fund-container');
    if (srcFundContainer) srcFundContainer.style.display = 'none';
  } else {
    typeEl.textContent = 'Pengeluaran';
    typeEl.className = 'txn-badge-type pengeluaran';
    document.getElementById('detail-cat-sumber-label').textContent = 'Kategori Bidang:';
    document.getElementById('detail-pic-label').textContent = 'Pengambil Dana:';
    document.getElementById('detail-amount').className = 'detail-value font-bold text-danger';
    
    const srcFundContainer = document.getElementById('detail-source-fund-container');
    if (srcFundContainer) {
      srcFundContainer.style.display = 'block';
      document.getElementById('detail-source-fund-value').textContent = txn.sumberDana || 'Tidak dispesifikasi';
    }
  }
  
  document.getElementById('detail-date').textContent = formatIndonesianDate(txn.tanggal);
  const catEl = document.getElementById('detail-cat-value');
  if (catEl) catEl.textContent = getTxCategory(txn);
  const sumberEl = document.getElementById('detail-sumber-value');
  if (sumberEl) sumberEl.textContent = getTxSumber(txn);
  document.getElementById('detail-pic-value').textContent = txn.pic;
  document.getElementById('detail-amount').textContent = formatRupiah(txn.nominal);
  document.getElementById('detail-description').textContent = txn.keterangan;
  
  // Render attachments
  const renderArea = document.getElementById('attachment-preview-render');
  renderArea.innerHTML = '';
  
  if (txn.attachment) {
    // Standardize attachments to an array
    const attachments = Array.isArray(txn.attachment) ? txn.attachment : [txn.attachment];
    const validAttachments = attachments.filter(att => att && att.base64);
    
    if (validAttachments.length > 0) {
      validAttachments.forEach(att => {
        if (att.type.startsWith('image/')) {
          const img = document.createElement('img');
          img.src = att.base64;
          img.alt = att.name;
          img.style.maxWidth = '150px';
          img.style.maxHeight = '150px';
          img.style.margin = '5px';
          img.style.cursor = 'pointer';
          img.style.border = '1px solid #ddd';
          img.style.borderRadius = '4px';
          img.title = `Klik untuk memperbesar gambar: ${att.name}`;
          img.addEventListener('click', () => {
            const w = window.open();
            w.document.write(`<title>${att.name}</title><img src="${att.base64}" style="max-width:100%; max-height:100vh; display:block; margin:auto;" />`);
            w.document.close();
          });
          renderArea.appendChild(img);
        } else if (att.type === 'application/pdf') {
          const box = document.createElement('div');
          box.className = 'pdf-preview-box';
          box.style.display = 'inline-flex';
          box.style.alignItems = 'center';
          box.style.gap = '10px';
          box.style.margin = '5px';
          box.style.padding = '8px';
          box.style.border = '1px solid #ddd';
          box.style.borderRadius = '4px';
          
          const icon = document.createElement('div');
          icon.className = 'pdf-icon';
          icon.textContent = '📄';
          
          const nameText = document.createElement('span');
          nameText.textContent = att.name.length > 20 ? att.name.substring(0, 17) + '...' : att.name;
          nameText.className = 'font-bold text-muted';
          
          const link = document.createElement('button');
          link.className = 'btn btn-secondary btn-small';
          link.textContent = 'Lihat PDF';
          link.addEventListener('click', () => {
            const pdfWindow = window.open();
            pdfWindow.document.write(`<title>${att.name}</title><iframe width='100%' height='100%' src='${att.base64}'></iframe>`);
            pdfWindow.document.close();
          });
          
          box.appendChild(icon);
          box.appendChild(nameText);
          box.appendChild(link);
          renderArea.appendChild(box);
        }
      });
    } else {
      renderArea.innerHTML = '<span class="text-muted">Tidak ada bukti transaksi/nota dilampirkan.</span>';
    }
  } else {
    renderArea.innerHTML = '<span class="text-muted">Tidak ada bukti transaksi/nota dilampirkan.</span>';
  }
  
  // Set sync individual action button states
  const btnSyncIndiv = document.getElementById('btn-sync-individual');
  if (!state.settings.sheetUrl) {
    btnSyncIndiv.style.display = 'none';
  } else {
    btnSyncIndiv.style.display = 'inline-flex';
    if (txn.sync) {
      btnSyncIndiv.disabled = true;
      btnSyncIndiv.textContent = 'Tersinkronisasi';
      btnSyncIndiv.className = 'btn btn-secondary btn-small';
    } else {
      btnSyncIndiv.disabled = false;
      btnSyncIndiv.textContent = 'Sinkronkan ke Sheet';
      btnSyncIndiv.className = 'btn btn-success btn-small';
    }
  }
  
  // Open modal
  modal.classList.add('open');
  
  // Save active txn ID for modal action buttons
  modal.dataset.activeTxnId = txn.id;
}

// Modal closing events setup
function setupCustomModalsClose() {
  const modal = document.getElementById('detail-modal');
  const closeModal = () => modal.classList.remove('open');
  
  document.getElementById('btn-close-modal').addEventListener('click', closeModal);
  document.getElementById('btn-close-modal-footer').addEventListener('click', closeModal);
  
  // Click overlay closes it
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeModal();
  });
  
  // Modal Delete Transaction
  document.getElementById('btn-delete-txn').addEventListener('click', async () => {
    const id = modal.dataset.activeTxnId;
    const match = state.transactions.find(t => t.id === id);
    if (!match) return;
    
    if (confirm(`Apakah Anda yakin ingin MENGHAPUS transaksi ${id}?\nNominal: ${formatRupiah(match.nominal)}\nKeterangan: "${match.keterangan}"`)) {
      // Hapus dari state lokal & IndexedDB
      state.transactions = state.transactions.filter(t => t.id !== id);
      await deleteFromStore(STORE_TXNS, id);
      
      // Selalu kirim hapus ke Google Sheets (tombstone jika gagal, retry saat startup berikutnya)
      if (state.settings.sheetUrl) {
        syncDeleteToSheets(id);
      } else {
        // Simpan ke tombstone agar dikirim saat URL tersedia
        try { await saveToStore(STORE_DELETED_IDS, { id, type: 'transaction', deletedAt: new Date().toISOString() }); } catch(e){}
      }
      
      closeModal();
      showToast('Transaksi Dihapus', `Transaksi ${id} berhasil dihapus dari web & Google Sheets.`, 'success');
      renderApp();
    }
  });
  
  // Modal Individual Sync Action
  document.getElementById('btn-sync-individual').addEventListener('click', async () => {
    const id = modal.dataset.activeTxnId;
    const match = state.transactions.find(t => t.id === id);
    if (match && !match.sync) {
      await syncTransactionToSheets(match);
      // Close & reopen to update modal state
      closeModal();
      showTransactionDetail(match);
      renderApp();
    }
  });
  
  // Modal Edit Transaction Action
  const btnEditTxn = document.getElementById('btn-edit-txn');
  if (btnEditTxn) {
    btnEditTxn.addEventListener('click', () => {
      const id = modal.dataset.activeTxnId;
      const match = state.transactions.find(t => t.id === id);
      if (match) {
        closeModal();
        openEditModal(match);
      }
    });
  }

  // Setup Edit Modal Closing Events
  const editModal = document.getElementById('edit-modal');
  const closeEditModal = () => {
    if (editModal) editModal.classList.remove('open');
  };
  
  const btnCloseEdit = document.getElementById('btn-close-edit-modal');
  if (btnCloseEdit) btnCloseEdit.addEventListener('click', closeEditModal);
  
  const btnCancelEdit = document.getElementById('btn-cancel-edit-modal');
  if (btnCancelEdit) btnCancelEdit.addEventListener('click', closeEditModal);
  
  if (editModal) {
    editModal.addEventListener('click', (e) => {
      if (e.target === editModal) closeEditModal();
    });
  }

  // Format Rupiah on edit-nominal
  const inputEditNominal = document.getElementById('edit-nominal');
  if (inputEditNominal) {
    inputEditNominal.addEventListener('keyup', (e) => {
      inputEditNominal.value = formatRupiahInput(e.target.value);
    });
  }

  // Toggle kategori group on edit-tipe change
  const editTipeSelect = document.getElementById('edit-tipe');
  if (editTipeSelect) {
    editTipeSelect.addEventListener('change', (e) => {
      const editKategoriGroup = document.getElementById('edit-kategori-group');
      if (e.target.value === 'IN') {
        if (editKategoriGroup) editKategoriGroup.style.display = 'none';
        document.getElementById('edit-kategori').value = '-';
      } else {
        if (editKategoriGroup) editKategoriGroup.style.display = 'block';
      }
    });
  }

  // Edit Transaction Form Submit
  const formEdit = document.getElementById('form-edit-transaction');
  if (formEdit) {
    formEdit.addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const id = document.getElementById('edit-txn-id').value;
      const tanggal = document.getElementById('edit-tanggal').value;
      const tipe = document.getElementById('edit-tipe').value;
      const kategori = tipe === 'IN' ? '-' : document.getElementById('edit-kategori').value;
      const sumber = document.getElementById('edit-sumber').value;
      const pic = document.getElementById('edit-pic').value;
      const nominal = parseRupiah(document.getElementById('edit-nominal').value);
      const keterangan = document.getElementById('edit-keterangan').value;
      
      if (nominal <= 0) {
        showToast('Input Salah', 'Nominal harus lebih besar dari Rp 0.', 'error');
        return;
      }
      
      const index = state.transactions.findIndex(t => t.id === id);
      if (index !== -1) {
        const updatedTxn = {
          ...state.transactions[index],
          tanggal,
          tipe,
          kategori,
          sumberDana: sumber,
          kategoriSumber: tipe === 'IN' ? sumber : kategori,
          pic,
          nominal,
          keterangan,
          sync: false
        };
        
        if (state.currentUpload) {
          updatedTxn.attachment = state.currentUpload;
        }
        
        state.transactions[index] = updatedTxn;
        await saveToStore(STORE_TXNS, updatedTxn);
        
        if (state.settings.autoSync && state.settings.sheetUrl) {
          syncTransactionToSheets(updatedTxn);
        }
        
        state.currentUpload = null;
        if (fileIndicatorEdit) fileIndicatorEdit.textContent = '';
        
        closeEditModal();
        showToast('Berhasil Diperbarui', `Transaksi ${id} berhasil diperbarui.`, 'success');
        renderApp();
      }
    });
  }
}

// Function to open & populate Edit Modal
function openEditModal(txn) {
  populateDropdowns();
  
  const editModal = document.getElementById('edit-modal');
  document.getElementById('edit-txn-id').value = txn.id;
  document.getElementById('edit-tanggal').value = txn.tanggal;
  document.getElementById('edit-tipe').value = txn.tipe;
  document.getElementById('edit-pic').value = txn.pic;
  document.getElementById('edit-nominal').value = formatRupiah(txn.nominal).replace('Rp ', '');
  document.getElementById('edit-keterangan').value = txn.keterangan;
  
  const editKategoriGroup = document.getElementById('edit-kategori-group');
  const editKategoriSelect = document.getElementById('edit-kategori');
  const editSumberSelect = document.getElementById('edit-sumber');
  
  if (txn.tipe === 'IN') {
    if (editKategoriGroup) editKategoriGroup.style.display = 'none';
    if (editKategoriSelect) editKategoriSelect.value = '-';
  } else {
    if (editKategoriGroup) editKategoriGroup.style.display = 'block';
    if (editKategoriSelect) editKategoriSelect.value = getTxCategory(txn);
  }
  
  if (editSumberSelect) {
    editSumberSelect.value = getTxSumber(txn) !== '-' ? getTxSumber(txn) : '';
  }
  
  state.currentUpload = null;
  if (fileIndicatorEdit) fileIndicatorEdit.textContent = '';
  
  editModal.classList.add('open');
}
// Run the closing events attachment
setupCustomModalsClose();

// ================= SETTINGS LOGIC =================
function setupSettingsHandlers() {
  document.getElementById('btn-save-settings').addEventListener('click', async () => {
    const url = document.getElementById('settings-sheet-url').value.trim();
    const autoSync = document.getElementById('settings-auto-sync').checked;
    
    state.settings.sheetUrl = url;
    state.settings.autoSync = autoSync;
    
    await saveToStore(STORE_SETTINGS, { key: 'sheetUrl', value: url });
    await saveToStore(STORE_SETTINGS, { key: 'autoSync', value: autoSync });
    
    showToast('Pengaturan Disimpan', 'Konfigurasi integrasi Google Sheets berhasil diperbarui.', 'success');
    updateSyncBadgeState();
    
    // Automatically trigger test connection and auto sync if URL saved
    if (url) {
      testGoogleSheetsConnection(false);
      autoSyncPendingTransactions();
    }
  });
  
  document.getElementById('btn-test-connection').addEventListener('click', () => {
    testGoogleSheetsConnection(true);
  });
  
  const btnPush = document.getElementById('btn-sync-push');
  if (btnPush) {
    btnPush.addEventListener('click', () => {
      pushAllTransactionsToSheets();
    });
  }
  
  const btnPull = document.getElementById('btn-sync-pull');
  if (btnPull) {
    btnPull.addEventListener('click', () => {
      pullAllTransactionsFromSheets();
    });
  }
  
  // Copy Apps Script code button
  document.getElementById('btn-copy-code').addEventListener('click', () => {
    const code = document.getElementById('code-script-content').textContent;
    navigator.clipboard.writeText(code).then(() => {
      showToast('Kode Disalin', 'Salin kode Apps Script ke clipboard berhasil.', 'success');
    }).catch(err => {
      showToast('Gagal Menyalin', 'Harap salin kode secara manual.', 'error');
    });
  });
}

// ================= EXPORTS LOGIC =================
function setupExportHandlers() {
  // CSV Export
  document.getElementById('btn-export-csv').addEventListener('click', () => {
    const filtered = filterTransactions();
    if (filtered.length === 0) {
      showToast('Data Kosong', 'Tidak ada data transaksi untuk diekspor.', 'error');
      return;
    }
    
    // Generate CSV contents
    // Separator semicolon (;) is friendly with Indonesian region Excel default separator
    let csv = '\ufeffNo;Tanggal;ID Transaksi;Tipe;Kategori;Sumber Dana;Penanggung Jawab;Keterangan;Nominal;Sync\n';
    
    filtered.forEach((t, i) => {
      const cleanDesc = t.keterangan.replace(/[\n\r;]/g, ' ');
      csv += `${i+1};${t.tanggal};${t.id};${t.tipe};${getTxCategory(t)};${getTxSumber(t)};${t.pic};${cleanDesc};${t.nominal};${t.sync ? 'YA' : 'BELUM'}\n`;
    });
    
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const dateStr = new Date().toISOString().split('T')[0];
    
    link.href = URL.createObjectURL(blob);
    link.setAttribute('download', `Laporan_Keuangan_Raimuna_Cilacap_${dateStr}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    showToast('Ekspor CSV', 'Laporan berhasil diunduh dalam format CSV.', 'success');
  });
  
  // Excel (HTML table layout approach) Export
  document.getElementById('btn-export-excel').addEventListener('click', () => {
    const filtered = filterTransactions();
    if (filtered.length === 0) {
      showToast('Data Kosong', 'Tidak ada data transaksi untuk diekspor.', 'error');
      return;
    }
    
    const dateStr = new Date().toISOString().split('T')[0];
    
    // Build standard HTML spreadsheet structure for Excel download
    let tableHtml = `
      <html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
      <head>
        <meta charset="utf-8">
        <!--[if gte mso 9]>
        <xml>
          <x:ExcelWorkbook>
            <x:ExcelWorksheets>
              <x:ExcelWorksheet>
                <x:Name>Laporan Raimuna</x:Name>
                <x:WorksheetOptions>
                  <x:DisplayGridlines/>
                </x:WorksheetOptions>
              </x:ExcelWorksheet>
            </x:ExcelWorksheets>
          </x:ExcelWorkbook>
        </xml>
        <![endif]-->
        <style>
          th { background-color: #f3f4f6; font-weight: bold; border: 1px solid #d1d5db; }
          td { border: 1px solid #d1d5db; }
          .number { mso-number-format:"\\#\\,\\#\\#0"; }
          .date { mso-number-format:"yyyy\\-mm\\-dd"; }
        </style>
      </head>
      <body>
        <h2>LAPORAN KEUANGAN BENDAHARA RAIMUNA CABANG CILACAP 2026</h2>
        <p>Tanggal Unduh: ${dateStr}</p>
        <table>
          <thead>
            <tr>
              <th>No</th>
              <th>Tanggal</th>
              <th>ID Transaksi</th>
              <th>Tipe</th>
              <th>Kategori</th>
              <th>Sumber Dana</th>
              <th>Penanggung Jawab</th>
              <th>Keterangan</th>
              <th>Nominal (Rp)</th>
              <th>Sync</th>
            </tr>
          </thead>
          <tbody>
    `;
    
    filtered.forEach((t, i) => {
      tableHtml += `
        <tr>
          <td>${i+1}</td>
          <td class="date">${t.tanggal}</td>
          <td>${t.id}</td>
          <td>${t.tipe === 'IN' ? 'Pemasukan' : 'Pengeluaran'}</td>
          <td>${getTxCategory(t)}</td>
          <td>${getTxSumber(t)}</td>
          <td>${t.pic}</td>
          <td>${t.keterangan}</td>
          <td class="number">${t.nominal}</td>
          <td>${t.sync ? 'YA' : 'TIDAK'}</td>
        </tr>
      `;
    });
    
    tableHtml += `
          </tbody>
        </table>
      </body>
      </html>
    `;
    
    const blob = new Blob([tableHtml], { type: 'application/vnd.ms-excel;charset=utf-8' });
    const link = document.createElement('a');
    
    link.href = URL.createObjectURL(blob);
    link.setAttribute('download', `Laporan_Keuangan_Raimuna_Cilacap_${dateStr}.xls`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    
    showToast('Ekspor Excel', 'Laporan berhasil diunduh dalam format Excel.', 'success');
  });
  
  // Print Report Action
  document.getElementById('btn-print-report').addEventListener('click', () => {
    // 1. Prepare dynamic print header fields
    const summaryEl = document.getElementById('print-filter-summary-info');
    
    const fTipe = state.filters.tipe === 'ALL' ? 'Semua Tipe' : (state.filters.tipe === 'IN' ? 'Pemasukan' : 'Pengeluaran');
    const fBulan = state.filters.bulan === 'ALL' ? 'Semua Bulan' : getIndonesianMonthName(state.filters.bulan);
    const fTahun = state.filters.tahun === 'ALL' ? 'Semua Tahun' : state.filters.tahun;
    const fSearch = state.filters.search ? `Kata Kunci: "${state.filters.search}"` : 'Semua Transaksi';
    
    summaryEl.innerHTML = `
      <p><strong>Filter Cetak:</strong> ${fTipe} | Periode: ${fBulan} ${fTahun} | Pencarian: ${fSearch}</p>
      <p><strong>Total Dana Cetak:</strong> ${formatRupiah(state.transactions.filter(t => t.tipe === 'IN').reduce((acc, t) => acc + t.nominal, 0))} Pemasukan | ${formatRupiah(state.transactions.filter(t => t.tipe === 'OUT').reduce((acc, t) => acc + t.nominal, 0))} Pengeluaran</p>
    `;
    
    // Set current print date
    const printDate = new Date();
    document.getElementById('print-current-date').textContent = `${printDate.getDate()} ${getIndonesianMonthName(String(printDate.getMonth() + 1).padStart(2, '0'))} ${printDate.getFullYear()}`;
    
    // 2. Trigger Print Dialog
    window.print();
  });
}

// Convert numeric string month key to Indonesian month word
function getIndonesianMonthName(mm) {
  const monthNames = [
    'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
    'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'
  ];
  return monthNames[parseInt(mm, 10)-1] || '';
}

// ================= TOAST NOTIFICATION launcher =================
function showToast(title, message, type = 'success') {
  const container = document.getElementById('toast-container');
  
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  
  const icons = {
    success: '🎉',
    error: '⚠️',
    info: 'ℹ️'
  };
  
  toast.innerHTML = `
    <div class="toast-icon">${icons[type] || '🔔'}</div>
    <div class="toast-content">
      <div class="toast-title">${title}</div>
      <div class="toast-message">${message}</div>
    </div>
  `;
  
  container.appendChild(toast);
  
  // Trigger transition animation
  setTimeout(() => toast.classList.add('show'), 50);
  
  // Auto remove after 4 seconds
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => {
      container.removeChild(toast);
    }, 300);
  }, 4000);
}

// ================= LOGIN & SECURITY LOGIC =================
// Helper function to hash a string to SHA-256 hex
async function sha256(message) {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return hashHex;
}

async function checkLoginState() {
  const isLoggedIn = localStorage.getItem('isLoggedIn') === 'true';
  const loginContainer = document.getElementById('login-container');
  if (isLoggedIn) {
    loginContainer.classList.add('hidden');
  } else {
    loginContainer.classList.remove('hidden');
  }
}

function setupLoginHandler() {
  const loginForm = document.getElementById('login-form');
  const errorMsg = document.getElementById('login-error-message');
  
  if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('login-email').value.trim();
      const password = document.getElementById('login-password').value;
      
      // Hash input credentials
      const emailHash = await sha256(email.toLowerCase());
      const passwordHash = await sha256(password);
      
      // Hardcoded hashes (securely hidden as SHA-256)
      const targetEmailHash = "a587a2cdb7a744a1096976ba46b775bed6da431b3fa75c1902b8fe093dabba09";
      const targetPasswordHash = "dff9cd137cab8b96431ccd81f8bb433fc71f0329eefb54bd4380b3fc3a9fc5d1";
      
      if (emailHash === targetEmailHash && passwordHash === targetPasswordHash) {
        localStorage.setItem('isLoggedIn', 'true');
        errorMsg.classList.add('hidden');
        document.getElementById('login-container').classList.add('hidden');
        showToast('Login Berhasil', 'Selamat datang di Aplikasi Bendahara Raimuna.', 'success');
        
        // Clear form inputs
        document.getElementById('login-email').value = '';
        document.getElementById('login-password').value = '';
      } else {
        errorMsg.classList.remove('hidden');
        showToast('Login Gagal', 'Email atau kata sandi Anda salah.', 'error');
      }
    });
  }
  
  // Logout handler
  const logoutBtn = document.getElementById('btn-logout');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      if (confirm('Apakah Anda yakin ingin keluar dari aplikasi?')) {
        localStorage.removeItem('isLoggedIn');
        checkLoginState();
        showToast('Logged Out', 'Anda berhasil keluar dari aplikasi.', 'info');
      }
    });
  }
}

// ================= SPONSORSHIP KWITANSI LOGIC =================

// Helper: Convert numbers to Indonesian words ("Terbilang")
function terbilangIndo(angka) {
  angka = Math.abs(parseInt(angka, 10)) || 0;
  if (angka === 0) return 'NOL RUPIAH';
  
  const satuan = ['', 'SATU', 'DUA', 'TIGA', 'EMPAT', 'LIMA', 'ENAM', 'TUJUH', 'DELAPAN', 'SEMBILAN', 'SEPULUH', 'SEBELAS'];
  
  function baca(n) {
    if (n < 12) return satuan[n];
    if (n < 20) return baca(n - 10) + ' BELAS';
    if (n < 100) return baca(Math.floor(n / 10)) + ' PULUH ' + (n % 10 !== 0 ? baca(n % 10) : '');
    if (n < 200) return 'SERATUS ' + (n - 100 !== 0 ? baca(n - 100) : '');
    if (n < 1000) return baca(Math.floor(n / 100)) + ' RATUS ' + (n % 100 !== 0 ? baca(n % 100) : '');
    if (n < 2000) return 'SERIBU ' + (n - 1000 !== 0 ? baca(n - 1000) : '');
    if (n < 1000000) return baca(Math.floor(n / 1000)) + ' RIBU ' + (n % 1000 !== 0 ? baca(n % 1000) : '');
    if (n < 1000000000) return baca(Math.floor(n / 1000000)) + ' JUTA ' + (n % 1000000 !== 0 ? baca(n % 1000000) : '');
    if (n < 1000000000000) return baca(Math.floor(n / 1000000000)) + ' MILYAR ' + (n % 1000000000 !== 0 ? baca(n % 1000000000) : '');
    return n.toString();
  }
  
  let hasil = baca(angka).replace(/\s+/g, ' ').trim();
  return (hasil + ' RUPIAH').toUpperCase();
}

let isSponsorshipSetupDone = false;

function setupSponsorshipHandlers() {
  if (isSponsorshipSetupDone) return;
  
  const kwitansiNo = document.getElementById('kwitansi-no');
  const kwitansiTgl = document.getElementById('kwitansi-tgl');
  const kwitansiDari = document.getElementById('kwitansi-dari');
  const kwitansiTipeJenis = document.getElementById('kwitansi-tipe-jenis');
  const kwitansiNominal = document.getElementById('kwitansi-nominal');
  const kwitansiTerbilang = document.getElementById('kwitansi-terbilang');
  const kwitansiGuna = document.getElementById('kwitansi-guna');
  const kwitansiPenerima = document.getElementById('kwitansi-penerima');
  const kwitansiNta = document.getElementById('kwitansi-nta');
  const kwitansiLembar = document.getElementById('kwitansi-lembar');
  const selectTx = document.getElementById('sponsor-select-tx');
  const btnPrint = document.getElementById('btn-print-kwitansi');
  const btnReset = document.getElementById('btn-reset-kwitansi');
  
  if (!kwitansiNo) return;

  if (kwitansiTipeJenis) {
    kwitansiTipeJenis.addEventListener('change', (e) => {
      const val = e.target.value;
      const labelNominal = document.getElementById('label-kwitansi-nominal');
      
      if (val === 'JELANTAH') {
        if (labelNominal) labelNominal.textContent = 'Jumlah Berat (KG)';
        kwitansiNominal.value = '150';
        kwitansiTerbilang.value = 'SERATUS LIMA PULUH KILOGRAM';
        kwitansiGuna.value = 'PERSYARATAN MINYAK JELANTAH';
        kwitansiPenerima.value = 'Tri Soma Ananta Rahman';
        kwitansiNta.value = 'Ketua Panitia';
      } else if (val === 'STAND' || val === 'TENANT') {
        if (labelNominal) labelNominal.textContent = 'Nominal Uang (Rp)';
        if (!kwitansiGuna.value || kwitansiGuna.value.includes('SPONSORSHIP') || kwitansiGuna.value.includes('JELANTAH')) {
          kwitansiGuna.value = 'PEMBAYARAN SEWA TENANT BOOTH RAIMUNA CABANG CILACAP TAHUN 2026';
        }
        if (kwitansiPenerima.value === 'Tri Soma Ananta Rahman') {
          kwitansiPenerima.value = 'Sulis Rahayu';
          kwitansiNta.value = 'NTA. 11.01.00.100806.00001';
        }
      } else {
        if (labelNominal) labelNominal.textContent = 'Nominal Uang (Rp)';
        if (!kwitansiGuna.value || kwitansiGuna.value.includes('TENANT') || kwitansiGuna.value.includes('JELANTAH')) {
          kwitansiGuna.value = 'SPONSORSHIP KEGIATAN RAIMUNA CABANG CILACAP TAHUN 2026';
        }
        if (kwitansiPenerima.value === 'Tri Soma Ananta Rahman') {
          kwitansiPenerima.value = 'Sulis Rahayu';
          kwitansiNta.value = 'NTA. 11.01.00.100806.00001';
        }
      }
      updateKwitansiLivePreview();
    });
  }
  
  // Format nominal input as rupiah or KG based on type
  kwitansiNominal.addEventListener('input', (e) => {
    const valType = kwitansiTipeJenis?.value || 'SPONSORSHIP';
    let raw = e.target.value.replace(/[^0-9]/g, '');
    if (valType === 'JELANTAH') {
      if (raw) {
        e.target.value = raw;
        kwitansiTerbilang.value = terbilangIndo(raw).toUpperCase() + ' KILOGRAM';
      } else {
        e.target.value = '';
        kwitansiTerbilang.value = '';
      }
    } else {
      if (raw) {
        e.target.value = formatRupiahDisplay(raw);
        kwitansiTerbilang.value = terbilangIndo(raw);
      } else {
        e.target.value = '';
        kwitansiTerbilang.value = '';
      }
    }
    updateKwitansiLivePreview();
  });
  
  // Auto-fill from transaction selector
  selectTx.addEventListener('change', (e) => {
    const txId = e.target.value;
    if (!txId) return;
    
    const tx = state.transactions.find(t => t.id === txId);
    if (tx) {
      const srcName = getTxSumber(tx);
      const isJelantah = srcName === 'Minyak Jelantah' || (tx.keterangan && tx.keterangan.toLowerCase().includes('jelantah'));
      const isTenant = srcName === 'Pembayaran Tenant' || srcName === 'Pembayaran Stand' || (tx.keterangan && (tx.keterangan.toLowerCase().includes('tenant') || tx.keterangan.toLowerCase().includes('stand')));
      
      if (kwitansiTipeJenis) {
        kwitansiTipeJenis.value = isJelantah ? 'JELANTAH' : (isTenant ? 'STAND' : 'SPONSORSHIP');
      }
      
      const labelNominal = document.getElementById('label-kwitansi-nominal');

      if (isJelantah) {
        if (labelNominal) labelNominal.textContent = 'Jumlah Berat (KG)';
        kwitansiDari.value = tx.pic || srcName || 'Donatur Minyak Jelantah';
        kwitansiNominal.value = '150';
        kwitansiTerbilang.value = 'SERATUS LIMA PULUH KILOGRAM';
        kwitansiGuna.value = tx.keterangan || 'PERSYARATAN MINYAK JELANTAH';
        kwitansiPenerima.value = 'Tri Soma Ananta Rahman';
        kwitansiNta.value = 'Ketua Panitia';
      } else if (isTenant) {
        if (labelNominal) labelNominal.textContent = 'Nominal Uang (Rp)';
        kwitansiDari.value = tx.pic || srcName || 'Penyewa Tenant / Sponsor';
        kwitansiNominal.value = formatRupiahDisplay(tx.nominal);
        kwitansiTerbilang.value = terbilangIndo(tx.nominal);
        kwitansiGuna.value = tx.keterangan ? `PEMBAYARAN SEWA TENANT BOOTH RAIMUNA CABANG CILACAP TAHUN 2026 (${tx.keterangan})` : 'PEMBAYARAN SEWA TENANT BOOTH RAIMUNA CABANG CILACAP TAHUN 2026';
        kwitansiPenerima.value = 'Sulis Rahayu';
        kwitansiNta.value = 'NTA. 11.01.00.100806.00001';
      } else {
        if (labelNominal) labelNominal.textContent = 'Nominal Uang (Rp)';
        kwitansiDari.value = tx.pic || srcName || 'Sponsor Eksternal';
        kwitansiNominal.value = formatRupiahDisplay(tx.nominal);
        kwitansiTerbilang.value = terbilangIndo(tx.nominal);
        kwitansiGuna.value = tx.keterangan || 'SPONSORSHIP KEGIATAN RAIMUNA CABANG CILACAP TAHUN 2026';
        kwitansiPenerima.value = 'Sulis Rahayu';
        kwitansiNta.value = 'NTA. 11.01.00.100806.00001';
      }
      if (tx.tanggal) {
        kwitansiTgl.value = formatTanggalIndoFull(tx.tanggal);
      }
      updateKwitansiLivePreview();
    }
  });

  // Listen for changes on all input fields to update preview live
  const inputs = [kwitansiTipeJenis, kwitansiNo, kwitansiTgl, kwitansiDari, kwitansiTerbilang, kwitansiGuna, kwitansiPenerima, kwitansiNta, kwitansiLembar];
  inputs.forEach(inp => {
    if (inp) {
      inp.addEventListener('input', updateKwitansiLivePreview);
      inp.addEventListener('change', updateKwitansiLivePreview);
    }
  });
  
  btnPrint.addEventListener('click', () => {
    printSponsorshipKwitansi();
  });
  
  btnReset.addEventListener('click', () => {
    selectTx.value = '';
    if (kwitansiTipeJenis) kwitansiTipeJenis.value = 'SPONSORSHIP';
    const labelNominal = document.getElementById('label-kwitansi-nominal');
    if (labelNominal) labelNominal.textContent = 'Nominal Uang (Rp)';
    kwitansiNo.value = getNextKwitansiNumber();
    kwitansiDari.value = '';
    kwitansiNominal.value = '';
    kwitansiTerbilang.value = '';
    kwitansiGuna.value = 'SPONSORSHIP KEGIATAN RAIMUNA CABANG CILACAP TAHUN 2026';
    kwitansiPenerima.value = 'Sulis Rahayu';
    kwitansiNta.value = 'NTA. 11.01.00.100806.00001';
    
    const printDate = new Date();
    kwitansiTgl.value = `${printDate.getDate()} ${getIndonesianMonthName(String(printDate.getMonth() + 1).padStart(2, '0'))} ${printDate.getFullYear()}`;
    
    updateKwitansiLivePreview();
  });
  
  isSponsorshipSetupDone = true;
}

function getNextKwitansiNumber() {
  if (!state.sponsorshipHistory || state.sponsorshipHistory.length === 0) return '001';
  let maxNo = 0;
  state.sponsorshipHistory.forEach(item => {
    const rawNo = parseInt(String(item.no).replace(/[^0-9]/g, ''), 10);
    if (!isNaN(rawNo) && rawNo > maxNo) {
      maxNo = rawNo;
    }
  });
  const nextNo = maxNo + 1;
  return String(nextNo).padStart(3, '0');
}

function formatTanggalIndoFull(dateStr) {
  if (!dateStr) return '';
  const parts = dateStr.split('-');
  if (parts.length !== 3) return dateStr;
  const yyyy = parts[0];
  const mm = parts[1];
  const dd = parseInt(parts[2], 10);
  return `${dd} ${getIndonesianMonthName(mm)} ${yyyy}`;
}

function renderSponsorshipSection() {
  setupSponsorshipHandlers();
  
  // Populate Transaction selector with Pemasukan transactions
  const selectTx = document.getElementById('sponsor-select-tx');
  if (selectTx) {
    const incomeTxns = state.transactions.filter(t => t.tipe === 'IN');
    selectTx.innerHTML = '<option value="">-- Buat Kwitansi Manual / Custom --</option>';
    incomeTxns.forEach(tx => {
      const opt = document.createElement('option');
      opt.value = tx.id;
      const srcName = tx.pic || getTxSumber(tx) || 'Pemasukan';
      const isTenantTag = (getTxSumber(tx) === 'Pembayaran Tenant' || getTxSumber(tx) === 'Pembayaran Stand') ? '[Tenant] ' : '';
      opt.textContent = `${isTenantTag}${tx.tanggal} - ${srcName} (Rp ${formatRupiahDisplay(tx.nominal)})`;
      selectTx.appendChild(opt);
    });
  }
  
  // Default date if empty
  const kwitansiTgl = document.getElementById('kwitansi-tgl');
  if (kwitansiTgl && !kwitansiTgl.value) {
    const printDate = new Date();
    kwitansiTgl.value = `${printDate.getDate()} ${getIndonesianMonthName(String(printDate.getMonth() + 1).padStart(2, '0'))} ${printDate.getFullYear()}`;
  }

  // Set next receipt number if default
  const kwitansiNo = document.getElementById('kwitansi-no');
  if (kwitansiNo && (!kwitansiNo.value || kwitansiNo.value === '001')) {
    kwitansiNo.value = getNextKwitansiNumber();
  }

  // Render preview & history table
  updateKwitansiLivePreview();
  renderSponsorshipHistoryTable();
}

function setupKwitansiHistoryFilterHandlers() {
  const filterPills = document.getElementById('kwitansi-history-filter-pills');
  if (filterPills && !filterPills.dataset.setupDone) {
    const pills = filterPills.querySelectorAll('.btn-pill');
    pills.forEach(pill => {
      pill.addEventListener('click', () => {
        pills.forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        state.kwitansiHistoryFilter = pill.getAttribute('data-kw-filter') || 'ALL';
        renderSponsorshipHistoryTable();
      });
    });
    filterPills.dataset.setupDone = 'true';
  }

  setupKwitansiExportHandlers();
}

function setupKwitansiExportHandlers() {
  const btnExcel = document.getElementById('btn-export-kwitansi-excel');
  const btnCsv = document.getElementById('btn-export-kwitansi-csv');

  if (btnExcel && !btnExcel.dataset.setupDone) {
    btnExcel.addEventListener('click', () => exportKwitansiRecap('EXCEL'));
    btnExcel.dataset.setupDone = 'true';
  }

  if (btnCsv && !btnCsv.dataset.setupDone) {
    btnCsv.addEventListener('click', () => exportKwitansiRecap('CSV'));
    btnCsv.dataset.setupDone = 'true';
  }
}

function exportKwitansiRecap(format) {
  const history = state.sponsorshipHistory || [];
  const filter = state.kwitansiHistoryFilter || 'ALL';

  let filtered = history;
  if (filter === 'SPONSORSHIP') {
    filtered = history.filter(item => {
      const isJelantah = item.tipeJenis === 'JELANTAH' || (item.guna && item.guna.toUpperCase().includes('JELANTAH'));
      const isTenant = item.tipeJenis === 'STAND' || item.tipeJenis === 'TENANT' || (item.guna && (item.guna.toUpperCase().includes('TENANT') || item.guna.toUpperCase().includes('STAND')));
      return !isJelantah && !isTenant;
    });
  } else if (filter === 'TENANT') {
    filtered = history.filter(item => {
      const isTenant = item.tipeJenis === 'STAND' || item.tipeJenis === 'TENANT' || (item.guna && (item.guna.toUpperCase().includes('TENANT') || item.guna.toUpperCase().includes('STAND')));
      return isTenant;
    });
  } else if (filter === 'JELANTAH') {
    filtered = history.filter(item => {
      return item.tipeJenis === 'JELANTAH' || (item.guna && item.guna.toUpperCase().includes('JELANTAH'));
    });
  }

  if (filtered.length === 0) {
    showToast('Data Kosong', 'Tidak ada riwayat kwitansi untuk diekspor.', 'error');
    return;
  }

  const dateStr = new Date().toISOString().split('T')[0];

  if (format === 'CSV') {
    let csv = '\ufeffNo;No Kwitansi;Tipe / Kategori;Tanggal;Diterima Dari;Nominal / Berat;Terbilang;Keperluan;Penerima;NTA / Jabatan\n';
    filtered.forEach((item, i) => {
      const isJelantah = item.tipeJenis === 'JELANTAH' || (item.guna && item.guna.toUpperCase().includes('JELANTAH'));
      const isTenant = item.tipeJenis === 'STAND' || item.tipeJenis === 'TENANT' || (item.guna && (item.guna.toUpperCase().includes('TENANT') || item.guna.toUpperCase().includes('STAND')));
      const tipeText = isJelantah ? 'Minyak Jelantah' : (isTenant ? 'Pembayaran Tenant' : 'Sponsorship');
      const formattedNominal = isJelantah ? `${item.nominal || 150} KG` : item.nominal;
      const cleanGuna = (item.guna || '-').replace(/[\n\r;]/g, ' ');
      const cleanDari = (item.dari || '-').replace(/[\n\r;]/g, ' ');
      const cleanTerbilang = (item.terbilang || '-').replace(/[\n\r;]/g, ' ');

      csv += `${i+1};No. ${item.no || '001'};${tipeText};${item.tgl || '-'};${cleanDari};${formattedNominal};${cleanTerbilang};${cleanGuna};${item.penerima || '-'};${item.nta || '-'}\n`;
    });

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.setAttribute('download', `Rekap_Kwitansi_${filter}_${dateStr}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    showToast('Ekspor CSV', 'Rekap kwitansi berhasil diunduh.', 'success');
  } else if (format === 'EXCEL') {
    let tableRows = '';
    filtered.forEach((item, i) => {
      const isJelantah = item.tipeJenis === 'JELANTAH' || (item.guna && item.guna.toUpperCase().includes('JELANTAH'));
      const isTenant = item.tipeJenis === 'STAND' || item.tipeJenis === 'TENANT' || (item.guna && (item.guna.toUpperCase().includes('TENANT') || item.guna.toUpperCase().includes('STAND')));
      const tipeText = isJelantah ? 'Minyak Jelantah' : (isTenant ? 'Pembayaran Tenant' : 'Sponsorship');
      const formattedNominal = isJelantah ? `${item.nominal || 150} KG` : formatRupiah(item.nominal || 0);

      tableRows += `
        <tr>
          <td style="text-align:center;">${i+1}</td>
          <td>No. ${item.no || '001'}</td>
          <td>${tipeText}</td>
          <td>${item.tgl || '-'}</td>
          <td><b>${item.dari || '-'}</b></td>
          <td style="text-align:right;">${formattedNominal}</td>
          <td>${item.terbilang || '-'}</td>
          <td>${item.guna || '-'}</td>
          <td>${item.penerima || '-'}</td>
          <td>${item.nta || '-'}</td>
        </tr>
      `;
    });

    const tableHtml = `
      <html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
      <head>
        <meta charset="utf-8">
        <style>
          th { background-color: #0284c7; color: white; font-weight: bold; border: 1px solid #cbd5e1; padding: 8px; }
          td { border: 1px solid #cbd5e1; padding: 6px; }
        </style>
      </head>
      <body>
        <h2>REKAP KWITANSI & TANDA TERIMA RAIMUNA CABANG CILACAP 2026</h2>
        <p>Kategori Filter: ${filter} | Tanggal Ekspor: ${dateStr}</p>
        <table>
          <thead>
            <tr>
              <th>No.</th>
              <th>No. Kwitansi</th>
              <th>Tipe</th>
              <th>Tanggal</th>
              <th>Diterima Dari</th>
              <th>Nominal / Jumlah</th>
              <th>Terbilang</th>
              <th>Keperluan</th>
              <th>Penerima</th>
              <th>NTA / Jabatan</th>
            </tr>
          </thead>
          <tbody>
            ${tableRows}
          </tbody>
        </table>
      </body>
      </html>
    `;

    const blob = new Blob([tableHtml], { type: 'application/vnd.ms-excel;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.setAttribute('download', `Rekap_Kwitansi_${filter}_${dateStr}.xls`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    showToast('Ekspor Excel', 'Rekap kwitansi berhasil diunduh dalam format Excel.', 'success');
  }
}

function renderSponsorshipHistoryTable() {
  setupKwitansiHistoryFilterHandlers();
  const history = state.sponsorshipHistory || [];

  const sponsorshipItems = history.filter(item => {
    const isJelantah = item.tipeJenis === 'JELANTAH' || (item.guna && item.guna.toUpperCase().includes('JELANTAH'));
    const isTenant = item.tipeJenis === 'STAND' || item.tipeJenis === 'TENANT' || (item.guna && (item.guna.toUpperCase().includes('TENANT') || item.guna.toUpperCase().includes('STAND')));
    return !isJelantah && !isTenant;
  });

  const tenantItems = history.filter(item => {
    const isJelantah = item.tipeJenis === 'JELANTAH' || (item.guna && item.guna.toUpperCase().includes('JELANTAH'));
    const isTenant = item.tipeJenis === 'STAND' || item.tipeJenis === 'TENANT' || (item.guna && (item.guna.toUpperCase().includes('TENANT') || item.guna.toUpperCase().includes('STAND')));
    return !isJelantah && isTenant;
  });

  const jelantahItems = history.filter(item => {
    return item.tipeJenis === 'JELANTAH' || (item.guna && item.guna.toUpperCase().includes('JELANTAH'));
  });

  // Render Table 1: Sponsorship
  renderSingleKwitansiHistoryTable('sponsorship', sponsorshipItems, 'sponsorship-history-tbody', 'sponsorship-count-badge', 'sponsorship-amount-badge', 'RP');

  // Render Table 2: Tenant
  renderSingleKwitansiHistoryTable('tenant', tenantItems, 'tenant-history-tbody', 'tenant-count-badge', 'tenant-amount-badge', 'RP');

  // Render Table 3: Jelantah
  renderSingleKwitansiHistoryTable('jelantah', jelantahItems, 'jelantah-history-tbody', 'jelantah-count-badge', 'jelantah-amount-badge', 'KG');

  // Apply Filter Visibility
  const filter = state.kwitansiHistoryFilter || 'ALL';
  const cardSponsorship = document.getElementById('kw-card-sponsorship');
  const cardTenant = document.getElementById('kw-card-tenant');
  const cardJelantah = document.getElementById('kw-card-jelantah');

  if (cardSponsorship) cardSponsorship.style.display = (filter === 'ALL' || filter === 'SPONSORSHIP') ? 'block' : 'none';
  if (cardTenant) cardTenant.style.display = (filter === 'ALL' || filter === 'TENANT') ? 'block' : 'none';
  if (cardJelantah) cardJelantah.style.display = (filter === 'ALL' || filter === 'JELANTAH') ? 'block' : 'none';
}

function renderSingleKwitansiHistoryTable(typeKey, items, tbodyId, countBadgeId, amountBadgeId, unitType) {
  const tbody = document.getElementById(tbodyId);
  const countBadge = document.getElementById(countBadgeId);
  const amountBadge = document.getElementById(amountBadgeId);

  const totalCount = items.length;
  let totalAmount = 0;

  if (unitType === 'KG') {
    totalAmount = items.reduce((sum, item) => sum + (parseInt(String(item.nominal).replace(/[^0-9]/g, ''), 10) || 150), 0);
  } else {
    totalAmount = items.reduce((sum, item) => sum + (parseInt(item.nominal, 10) || 0), 0);
  }

  if (countBadge) countBadge.textContent = `${totalCount} ${typeKey === 'jelantah' ? 'Tanda Terima' : 'Kwitansi'}`;
  if (amountBadge) amountBadge.textContent = unitType === 'KG' ? `${totalAmount} KG` : formatRupiah(totalAmount);

  if (!tbody) return;

  if (items.length === 0) {
    const labelEmpty = typeKey === 'jelantah' ? 'minyak jelantah' : (typeKey === 'tenant' ? 'pembayaran tenant' : 'sponsorship');
    tbody.innerHTML = `
      <tr>
        <td colspan="7" class="text-center text-muted" style="padding: 25px;">
          Belum ada riwayat ${labelEmpty} yang dicetak.
        </td>
      </tr>
    `;
    return;
  }

  let html = '';
  items.forEach(item => {
    const formattedNominal = unitType === 'KG'
      ? `${item.nominal || 150} KG`
      : formatRupiah(item.nominal || 0);

    let badgeTag = '<span class="badge-type balance" style="font-size: 0.75rem;">Sponsorship</span>';
    if (typeKey === 'tenant') badgeTag = '<span class="badge-type in" style="font-size: 0.75rem;">Tenant</span>';
    if (typeKey === 'jelantah') badgeTag = '<span class="badge-type out" style="font-size: 0.75rem; background-color: #fef3c7; color: #92400e;">Jelantah</span>';

    html += `
      <tr>
        <td><span class="kwitansi-no-badge">No. ${item.no || '001'}</span> ${badgeTag}</td>
        <td>${item.tgl || '-'}</td>
        <td><strong>${item.dari || '-'}</strong></td>
        <td class="text-right font-bold text-success">${formattedNominal}</td>
        <td>${item.guna || '-'}</td>
        <td>${item.penerima || '-'}</td>
        <td class="text-center">
          <div class="history-actions">
            <button type="button" class="btn btn-small btn-secondary btn-icon-small" onclick="loadKwitansiFromHistory('${item.id}')" title="Cetak Ulang / Muat Data">
              🖨️ Muat & Cetak
            </button>
            <button type="button" class="btn btn-small btn-danger btn-icon-small" onclick="deleteSponsorshipHistory('${item.id}')" title="Hapus Riwayat">
              🗑️
            </button>
          </div>
        </td>
      </tr>
    `;
  });

  tbody.innerHTML = html;
}

async function loadKwitansiFromHistory(id, autoPrint = true) {
  const item = state.sponsorshipHistory.find(h => h.id === id);
  if (!item) return;

  const kwitansiTipeJenis = document.getElementById('kwitansi-tipe-jenis');
  const kwitansiNo = document.getElementById('kwitansi-no');
  const kwitansiTgl = document.getElementById('kwitansi-tgl');
  const kwitansiDari = document.getElementById('kwitansi-dari');
  const kwitansiNominal = document.getElementById('kwitansi-nominal');
  const kwitansiTerbilang = document.getElementById('kwitansi-terbilang');
  const kwitansiGuna = document.getElementById('kwitansi-guna');
  const kwitansiPenerima = document.getElementById('kwitansi-penerima');
  const kwitansiNta = document.getElementById('kwitansi-nta');

  const isJelantah = item.tipeJenis === 'JELANTAH' || (item.guna && item.guna.toUpperCase().includes('JELANTAH'));
  const isTenant = item.tipeJenis === 'STAND' || item.tipeJenis === 'TENANT' || (item.guna && (item.guna.toUpperCase().includes('TENANT') || item.guna.toUpperCase().includes('STAND')));

  if (kwitansiTipeJenis) kwitansiTipeJenis.value = isJelantah ? 'JELANTAH' : (isTenant ? 'STAND' : 'SPONSORSHIP');
  if (kwitansiNo) kwitansiNo.value = item.no || '001';
  if (kwitansiTgl) kwitansiTgl.value = item.tgl || '';
  if (kwitansiDari) kwitansiDari.value = item.dari || '';
  if (kwitansiNominal) kwitansiNominal.value = isJelantah ? (item.nominal || '150') : formatRupiahDisplay(item.nominal || 0);
  if (kwitansiTerbilang) kwitansiTerbilang.value = item.terbilang || (isJelantah ? 'SERATUS LIMA PULUH KILOGRAM' : terbilangIndo(item.nominal || 0));
  if (kwitansiGuna) kwitansiGuna.value = item.guna || (isJelantah ? 'PERSYARATAN MINYAK JELANTAH' : 'SPONSORSHIP KEGIATAN RAIMUNA CABANG CILACAP TAHUN 2026');
  if (kwitansiPenerima) kwitansiPenerima.value = item.penerima || (isJelantah ? 'Tri Soma Ananta Rahman' : 'Sulis Rahayu');
  if (kwitansiNta) kwitansiNta.value = item.nta || (isJelantah ? 'Ketua Panitia' : 'NTA. 11.01.00.100806.00001');

  updateKwitansiLivePreview();

  if (autoPrint) {
    printSponsorshipKwitansi(false);
  } else {
    showToast('Kwitansi Dimuat', `Data Kwitansi No. ${item.no} berhasil dimuat ke form.`, 'info');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }
}

async function deleteSponsorshipHistory(id) {
  if (!confirm('Apakah Anda yakin ingin menghapus kwitansi ini dari riwayat?')) return;
  
  const item = state.sponsorshipHistory.find(h => h.id === id);
  const kwNo = item ? item.no : null;

  try {
    await deleteFromStore(STORE_SPONSORSHIPS, id);
  } catch(e){}
  
  state.sponsorshipHistory = state.sponsorshipHistory.filter(h => h.id !== id);
  try {
    localStorage.setItem('sponsorship_history', JSON.stringify(state.sponsorshipHistory));
  } catch(e){}
  
  if (state.settings.sheetUrl) {
    syncKwitansiToSheets_delete(id, kwNo);
  }

  renderSponsorshipHistoryTable();
  showToast('Riwayat Dihapus', 'Item kwitansi berhasil dihapus dari riwayat.', 'info');
}

async function syncKwitansiToSheets_delete(id, no) {
  if (!state.settings.sheetUrl) {
    // Simpan ke tombstone jika tidak ada URL
    try { await saveToStore(STORE_DELETED_IDS, { id, type: 'kwitansi', no: no || '', deletedAt: new Date().toISOString() }); } catch(e){}
    return;
  }
  // Simpan ke tombstone dulu sebelum coba kirim
  try { await saveToStore(STORE_DELETED_IDS, { id, type: 'kwitansi', no: no || '', deletedAt: new Date().toISOString() }); } catch(e){}
  try {
    await fetch(state.settings.sheetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ action: 'delete_kwitansi', id: id, no: no })
    });
    // Berhasil → hapus dari tombstone
    try { await deleteFromStore(STORE_DELETED_IDS, id); } catch(e){}
  } catch (err) {
    console.error('Gagal hapus kwitansi dari Sheet, akan dicoba ulang saat startup:', err);
    // Tombstone tetap tersimpan untuk retry berikutnya
  }
}

function generateKwitansiHTML() {
  const tipeJenis = document.getElementById('kwitansi-tipe-jenis')?.value || 'SPONSORSHIP';
  const no = document.getElementById('kwitansi-no')?.value || '001';
  const tgl = document.getElementById('kwitansi-tgl')?.value || '5 Agustus 2026';
  const dari = document.getElementById('kwitansi-dari')?.value || '........................................................';
  const nominalVal = document.getElementById('kwitansi-nominal')?.value || '0';
  const terbilang = document.getElementById('kwitansi-terbilang')?.value || (tipeJenis === 'JELANTAH' ? 'SERATUS LIMA PULUH KILOGRAM' : 'NOL RUPIAH');
  const guna = document.getElementById('kwitansi-guna')?.value || (tipeJenis === 'JELANTAH' ? 'PERSYARATAN MINYAK JELANTAH' : (tipeJenis === 'STAND' ? 'PEMBAYARAN SEWA TENANT BOOTH RAIMUNA CABANG CILACAP TAHUN 2026' : 'SPONSORSHIP KEGIATAN RAIMUNA CABANG CILACAP TAHUN 2026'));
  const penerima = document.getElementById('kwitansi-penerima')?.value || (tipeJenis === 'JELANTAH' ? 'Tri Soma Ananta Rahman' : 'Sulis Rahayu');
  const nta = document.getElementById('kwitansi-nta')?.value || (tipeJenis === 'JELANTAH' ? 'Ketua Panitia' : 'NTA. 11.01.00.100806.00001');

  let titleHeader = 'KWITANSI &nbsp; SPONSORSHIP';
  let amountBoxText = `Rp. &nbsp;${nominalVal},00`;
  let sigRoleText = 'Yang menerima,';

  if (tipeJenis === 'JELANTAH') {
    titleHeader = 'TANDA &nbsp; TERIMA &nbsp; JELANTAH';
    const kgDisplay = nominalVal.includes('KG') ? nominalVal : `${nominalVal} KG`;
    amountBoxText = kgDisplay;
    sigRoleText = (nta && !nta.startsWith('NTA')) ? `${nta},` : 'Ketua Panitia,';
  } else if (tipeJenis === 'STAND' || tipeJenis === 'TENANT') {
    titleHeader = 'KWITANSI &nbsp; PEMBAYARAN &nbsp; TENANT';
  }

  const showNtaLine = (tipeJenis !== 'JELANTAH' && nta && nta.startsWith('NTA'));

  return `
    <div class="kwitansi-box-frame">
      <div class="kwitansi-title-header">
        <h2>${titleHeader}</h2>
      </div>
      <table class="kwitansi-body-table">
        <tr>
          <td class="kwitansi-label-col">No.</td>
          <td class="kwitansi-sep-col">:</td>
          <td class="kwitansi-val-col font-bold">${no}</td>
        </tr>
        <tr>
          <td class="kwitansi-label-col">Telah Diterima Dari</td>
          <td class="kwitansi-sep-col">:</td>
          <td class="kwitansi-val-col">${dari}</td>
        </tr>
        <tr>
          <td class="kwitansi-label-col">Terbilang</td>
          <td class="kwitansi-sep-col">:</td>
          <td class="kwitansi-val-col"><span class="kwitansi-val-terbilang">${terbilang}</span></td>
        </tr>
        <tr>
          <td class="kwitansi-label-col">Keperluan</td>
          <td class="kwitansi-sep-col">:</td>
          <td class="kwitansi-val-col">${guna}</td>
        </tr>
      </table>
      <div class="kwitansi-footer-row">
        <div class="kwitansi-amount-box-container">
          <div class="kwitansi-amount-box">
            ${amountBoxText}
          </div>
        </div>
        <div class="kwitansi-sig-container">
          <div class="kwitansi-sig-date">Cilacap, ${tgl}</div>
          <div class="kwitansi-sig-role">${sigRoleText}</div>
          <div class="kwitansi-sig-name">${penerima}</div>
          ${showNtaLine ? `<div class="kwitansi-sig-nta">${nta}</div>` : ''}
        </div>
      </div>
    </div>
  `;
}

function updateKwitansiLivePreview() {
  const previewArea = document.getElementById('kwitansi-screen-preview');
  if (previewArea) {
    previewArea.innerHTML = generateKwitansiHTML();
  }
}

async function printSponsorshipKwitansi(saveHistory = true) {
  const printableArea = document.getElementById('kwitansi-printable-area');
  const numLembar = parseInt(document.getElementById('kwitansi-lembar')?.value || '2', 10);
  
  if (!printableArea) return;
  
  const kwitansiHtml = generateKwitansiHTML();
  
  if (numLembar === 2) {
    printableArea.innerHTML = `
      <div class="kwitansi-print-page">
        ${kwitansiHtml}
        <div class="kwitansi-divider-line"></div>
        ${kwitansiHtml}
      </div>
    `;
  } else {
    printableArea.innerHTML = `
      <div class="kwitansi-print-page">
        ${kwitansiHtml}
      </div>
    `;
  }

  if (saveHistory) {
    // Save entry to sponsorship history
    const tipeJenis = document.getElementById('kwitansi-tipe-jenis')?.value || 'SPONSORSHIP';
    const no = document.getElementById('kwitansi-no')?.value || '001';
    const tgl = document.getElementById('kwitansi-tgl')?.value || '';
    const dari = document.getElementById('kwitansi-dari')?.value || 'Sponsor / Tenant';
    const nominalStr = document.getElementById('kwitansi-nominal')?.value || '0';
    const nominalNum = tipeJenis === 'JELANTAH' ? nominalStr : parseRupiah(nominalStr);
    const terbilang = document.getElementById('kwitansi-terbilang')?.value || (tipeJenis === 'JELANTAH' ? 'SERATUS LIMA PULUH KILOGRAM' : terbilangIndo(nominalNum));
    const guna = document.getElementById('kwitansi-guna')?.value || '';
    const penerima = document.getElementById('kwitansi-penerima')?.value || (tipeJenis === 'JELANTAH' ? 'Tri Soma Ananta Rahman' : 'Sulis Rahayu');
    const nta = document.getElementById('kwitansi-nta')?.value || (tipeJenis === 'JELANTAH' ? 'Ketua Panitia' : 'NTA. 11.01.00.100806.00001');

    const historyItem = {
      id: 'KW-' + Date.now(),
      tipeJenis: tipeJenis,
      no: no,
      tgl: tgl,
      dari: dari,
      nominal: nominalNum,
      terbilang: terbilang,
      guna: guna,
      penerima: penerima,
      nta: nta,
      dateCreated: new Date().toISOString()
    };

    try {
      await saveToStore(STORE_SPONSORSHIPS, historyItem);
    } catch(e){}

    state.sponsorshipHistory.unshift(historyItem);
    try {
      localStorage.setItem('sponsorship_history', JSON.stringify(state.sponsorshipHistory));
    } catch(e){}

    renderSponsorshipHistoryTable();
    showToast('Kwitansi Disimpan', `Kwitansi No. ${no} berhasil dicatat ke Riwayat.`, 'success');

    if (state.settings.sheetUrl) {
      syncKwitansiToSheets(historyItem);
    }
  }
  
  window.print();
}

async function syncKwitansiToSheets(kw) {
  if (!state.settings.sheetUrl) return;
  try {
    await fetch(state.settings.sheetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ action: 'sync_kwitansi', kwitansi: kw })
    });
  } catch (err) {
    console.error('Failed to sync kwitansi to sheet:', err);
  }
}

// ================= UTANG MANAGEMENT & CHECKLIST LOGIC =================
function setupUtangHandlers() {
  const formAdd = document.getElementById('form-utang-add');
  if (formAdd) {
    formAdd.addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const tanggal = document.getElementById('utang-tanggal').value;
      const tipe = document.getElementById('utang-tipe').value;
      const nama = document.getElementById('utang-nama').value;
      const sumberKat = document.getElementById('utang-sumber-kat').value;
      const nominal = parseRupiah(document.getElementById('utang-nominal').value);
      const keterangan = document.getElementById('utang-keterangan').value;
      
      if (nominal <= 0) {
        showToast('Input Salah', 'Nominal utang harus lebih besar dari Rp 0.', 'error');
        return;
      }
      
      const newUtang = {
        id: generateUniqueId('UTG'),
        tanggal,
        tipe,
        nama: String(nama).trim(),
        sumberDana: sumberKat,
        kategori: sumberKat,
        nominal,
        keterangan: String(keterangan).trim(),
        status: 'BELUM_LUNAS',
        paidTxId: null,
        tanggalLunas: null,
        dateCreated: new Date().toISOString()
      };
      
      if (!state.utang) state.utang = [];
      state.utang.unshift(newUtang);
      
      try {
        await saveToStore(STORE_UTANG, newUtang);
      } catch (err) {
        console.warn('Save to STORE_UTANG failed, using localStorage fallback:', err);
      }

      try {
        localStorage.setItem('raimuna_utang_data', JSON.stringify(state.utang));
      } catch(e){}
      
      if (state.settings.sheetUrl) {
        syncUtangToSheets(newUtang);
      }

      showToast('Catatan Utang Tersimpan', `Utang ${newUtang.id} berhasil ditambahkan.`, 'success');
      
      formAdd.reset();
      const today = new Date().toISOString().split('T')[0];
      if (document.getElementById('utang-tanggal')) document.getElementById('utang-tanggal').value = today;
      
      renderUtangPage();
      renderDashboard();
    });
  }
  
  // Filter pills event listeners
  const filterContainer = document.getElementById('utang-filter-pills');
  if (filterContainer) {
    const pills = filterContainer.querySelectorAll('.btn-pill');
    pills.forEach(pill => {
      pill.addEventListener('click', () => {
        pills.forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        state.utangFilter = pill.getAttribute('data-filter') || 'ALL';
        renderUtangPage();
      });
    });
  }

  setupUtangExportHandlers();
}

function setupUtangExportHandlers() {
  const btnExcel = document.getElementById('btn-export-utang-excel');
  const btnCsv = document.getElementById('btn-export-utang-csv');

  if (btnExcel && !btnExcel.dataset.setupDone) {
    btnExcel.addEventListener('click', () => exportUtangRecap('EXCEL'));
    btnExcel.dataset.setupDone = 'true';
  }

  if (btnCsv && !btnCsv.dataset.setupDone) {
    btnCsv.addEventListener('click', () => exportUtangRecap('CSV'));
    btnCsv.dataset.setupDone = 'true';
  }
}

function exportUtangRecap(format) {
  const utangList = state.utang || [];
  const filter = state.utangFilter || 'ALL';

  const filtered = utangList.filter(u => {
    if (filter === 'BELUM_LUNAS') return u.status === 'BELUM_LUNAS';
    if (filter === 'LUNAS') return u.status === 'LUNAS';
    return true;
  });

  if (filtered.length === 0) {
    showToast('Data Kosong', 'Tidak ada catatan utang untuk diekspor.', 'error');
    return;
  }

  const dateStr = new Date().toISOString().split('T')[0];

  if (format === 'CSV') {
    let csv = '\ufeffNo;ID Utang;Tanggal;Tipe;Penanggung Jawab / Pihak;Sumber / Kategori;Nominal (Rp);Keterangan;Status;Tanggal Lunas\n';
    filtered.forEach((u, i) => {
      const tipeText = u.tipe === 'IN' ? 'Piutang (Masuk)' : 'Utang (Keluar)';
      const statusText = u.status === 'LUNAS' ? 'LUNAS' : 'BELUM LUNAS';
      const cleanNama = (u.nama || '-').replace(/[\n\r;]/g, ' ');
      const cleanSumber = (u.sumberDana || '-').replace(/[\n\r;]/g, ' ');
      const cleanKeterangan = (u.keterangan || '-').replace(/[\n\r;]/g, ' ');

      csv += `${i+1};${u.id};${u.tanggal};${tipeText};${cleanNama};${cleanSumber};${u.nominal};${cleanKeterangan};${statusText};${u.tanggalLunas || '-'}\n`;
    });

    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.setAttribute('download', `Rekap_Utang_${filter}_${dateStr}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    showToast('Ekspor CSV', 'Rekap utang berhasil diunduh.', 'success');
  } else if (format === 'EXCEL') {
    let tableRows = '';
    filtered.forEach((u, i) => {
      const tipeText = u.tipe === 'IN' ? 'Piutang (Masuk)' : 'Utang (Keluar)';
      const statusText = u.status === 'LUNAS' ? '<b style="color: #16a34a;">LUNAS ✅</b>' : '<b style="color: #dc2626;">BELUM LUNAS ⏳</b>';
      const formattedNominal = formatRupiah(u.nominal || 0);

      tableRows += `
        <tr>
          <td style="text-align:center;">${i+1}</td>
          <td>${u.id}</td>
          <td>${u.tanggal || '-'}</td>
          <td>${tipeText}</td>
          <td><b>${u.nama || '-'}</b></td>
          <td>${u.sumberDana || '-'}</td>
          <td style="text-align:right;">${formattedNominal}</td>
          <td>${u.keterangan || '-'}</td>
          <td style="text-align:center;">${statusText}</td>
          <td>${u.tanggalLunas || '-'}</td>
        </tr>
      `;
    });

    const tableHtml = `
      <html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
      <head>
        <meta charset="utf-8">
        <style>
          th { background-color: #0284c7; color: white; font-weight: bold; border: 1px solid #cbd5e1; padding: 8px; }
          td { border: 1px solid #cbd5e1; padding: 6px; }
        </style>
      </head>
      <body>
        <h2>REKAP CATATAN UTANG & PIUTANG RAIMUNA CABANG CILACAP 2026</h2>
        <p>Status Filter: ${filter} | Tanggal Ekspor: ${dateStr}</p>
        <table>
          <thead>
            <tr>
              <th>No.</th>
              <th>ID Utang</th>
              <th>Tanggal</th>
              <th>Tipe</th>
              <th>Penanggung Jawab / Pihak</th>
              <th>Sumber / Kategori</th>
              <th>Nominal</th>
              <th>Keterangan</th>
              <th>Status</th>
              <th>Tanggal Lunas</th>
            </tr>
          </thead>
          <tbody>
            ${tableRows}
          </tbody>
        </table>
      </body>
      </html>
    `;

    const blob = new Blob([tableHtml], { type: 'application/vnd.ms-excel;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.setAttribute('download', `Rekap_Utang_${filter}_${dateStr}.xls`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    showToast('Ekspor Excel', 'Rekap utang berhasil diunduh dalam format Excel.', 'success');
  }
}

function renderUtangPage() {
  const tbody = document.getElementById('table-utang-tbody');
  if (!tbody) return;
  
  tbody.innerHTML = '';
  
  // Metrics calculation
  let pendingSum = 0;
  let paidSum = 0;
  let count = (state.utang || []).length;
  
  state.utang.forEach(u => {
    if (u.status === 'BELUM_LUNAS') pendingSum += u.nominal;
    else if (u.status === 'LUNAS') paidSum += u.nominal;
  });
  
  if (document.getElementById('utang-metric-pending')) document.getElementById('utang-metric-pending').textContent = formatRupiah(pendingSum);
  if (document.getElementById('utang-metric-paid')) document.getElementById('utang-metric-paid').textContent = formatRupiah(paidSum);
  if (document.getElementById('utang-metric-count')) document.getElementById('utang-metric-count').textContent = count;
  
  // Filter
  const filtered = (state.utang || []).filter(u => {
    if (state.utangFilter === 'BELUM_LUNAS') return u.status === 'BELUM_LUNAS';
    if (state.utangFilter === 'LUNAS') return u.status === 'LUNAS';
    return true;
  });
  
  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="9" class="text-center text-muted">Belum ada catatan utang sesuai filter.</td></tr>';
    return;
  }
  
  filtered.forEach(u => {
    const tr = document.createElement('tr');
    const isPaid = u.status === 'LUNAS';
    
    const typeBadge = u.tipe === 'IN' 
      ? '<span class="badge-type in">Piutang (Masuk)</span>' 
      : '<span class="badge-type out">Utang (Keluar)</span>';
      
    const statusBadge = isPaid 
      ? '<span class="badge-status success">LUNAS ✅</span>' 
      : '<span class="badge-status warning">BELUM LUNAS ⏳</span>';
      
    tr.innerHTML = `
      <td class="text-center">
        <label class="custom-checkbox-container" title="Centang jika sudah dibayar / lunas">
          <input type="checkbox" class="utang-checklist-input" ${isPaid ? 'checked' : ''} data-id="${u.id}">
          <span class="custom-checkbox-checkmark"></span>
        </label>
      </td>
      <td>${formatIndonesianDate(u.tanggal)}</td>
      <td>${typeBadge}</td>
      <td class="font-bold">${u.nama}</td>
      <td>${u.sumberDana || '-'}</td>
      <td class="font-bold ${u.tipe === 'IN' ? 'text-success' : 'text-danger'}">${formatRupiah(u.nominal)}</td>
      <td>${u.keterangan}</td>
      <td>${statusBadge}</td>
      <td class="text-center">
        <button class="btn-icon btn-delete-utang" data-id="${u.id}" title="Hapus Catatan Utang">🗑️</button>
      </td>
    `;
    
    const chk = tr.querySelector('.utang-checklist-input');
    chk.addEventListener('change', (e) => {
      toggleUtangStatus(u.id, e.target.checked);
    });
    
    const btnDel = tr.querySelector('.btn-delete-utang');
    btnDel.addEventListener('click', () => {
      deleteUtang(u.id);
    });
    
    tbody.appendChild(tr);
  });
}

async function toggleUtangStatus(utangId, isPaid) {
  const item = state.utang.find(u => u.id === utangId);
  if (!item) return;
  
  if (isPaid) {
    item.status = 'LUNAS';
    item.tanggalLunas = new Date().toISOString().split('T')[0];
    
    // Automatically record transaction to state.transactions
    const tx = {
      id: generateUniqueId(item.tipe === 'IN' ? 'TXN-IN' : 'TXN-OUT'),
      tanggal: item.tanggalLunas,
      tipe: item.tipe,
      kategori: item.tipe === 'OUT' ? (item.sumberDana || 'Sekretariat') : '-',
      sumberDana: item.sumberDana || (item.tipe === 'IN' ? 'Pembayaran Tenant' : 'Lainnya'),
      kategoriSumber: item.sumberDana || 'Pelunasan Utang',
      pic: item.nama,
      nominal: item.nominal,
      keterangan: `[Pelunasan Utang] ${item.keterangan}`,
      attachment: null,
      dateCreated: new Date().toISOString(),
      sync: false
    };
    
    item.paidTxId = tx.id;
    await saveTransaction(tx);
    try { await saveToStore(STORE_UTANG, item); } catch(e){}
    try { localStorage.setItem('raimuna_utang_data', JSON.stringify(state.utang)); } catch(e){}
    if (state.settings.sheetUrl) { syncUtangToSheets(item); }
    
    showToast('Utang Dilunasi!', `Transaksi pelunasan ${tx.id} berhasil dicatat dan masuk ke Dashboard.`, 'success');
  } else {
    item.status = 'BELUM_LUNAS';
    item.tanggalLunas = null;
    
    if (item.paidTxId) {
      const txIdToDelete = item.paidTxId;
      item.paidTxId = null;
      
      // Remove transaction from local state & DB
      state.transactions = state.transactions.filter(t => t.id !== txIdToDelete);
      await deleteFromStore(STORE_TXNS, txIdToDelete);
      if (state.settings.autoSync && state.settings.sheetUrl) {
        syncDeleteToSheets(txIdToDelete);
      }
    }
    
    try { await saveToStore(STORE_UTANG, item); } catch(e){}
    try { localStorage.setItem('raimuna_utang_data', JSON.stringify(state.utang)); } catch(e){}
    if (state.settings.sheetUrl) { syncUtangToSheets(item); }
    showToast('Status Diperbarui', `Utang dikembalikan ke status BELUM LUNAS. Data pelunasan ditarik dari Dashboard.`, 'info');
  }
  
  renderUtangPage();
  renderDashboard();
}

async function deleteUtang(utangId) {
  if (!confirm('Apakah Anda yakin ingin menghapus catatan utang ini?')) return;
  
  const item = state.utang.find(u => u.id === utangId);
  if (item && item.paidTxId) {
    // Also remove the associated paid transaction
    const txIdToDelete = item.paidTxId;
    state.transactions = state.transactions.filter(t => t.id !== txIdToDelete);
    await deleteFromStore(STORE_TXNS, txIdToDelete);
    // Selalu coba kirim hapus ke sheet (dengan tombstone jika gagal)
    if (state.settings.sheetUrl) {
      syncDeleteToSheets(txIdToDelete);
    } else {
      try { await saveToStore(STORE_DELETED_IDS, { id: txIdToDelete, type: 'transaction', deletedAt: new Date().toISOString() }); } catch(e){}
    }
  }
  
  state.utang = state.utang.filter(u => u.id !== utangId);
  try { await deleteFromStore(STORE_UTANG, utangId); } catch(e){}
  try { localStorage.setItem('raimuna_utang_data', JSON.stringify(state.utang)); } catch(e){}
  if (state.settings.sheetUrl) { syncUtangToSheets_delete(utangId); }
  
  showToast('Catatan Utang Dihapus', 'Data utang berhasil dihapus.', 'info');
  renderUtangPage();
  renderDashboard();
}

async function syncUtangToSheets(ut) {
  if (!state.settings.sheetUrl) return;
  try {
    await fetch(state.settings.sheetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ action: 'sync_utang', utang: ut })
    });
  } catch (err) {
    console.error('Failed to sync utang to sheet:', err);
  }
}

async function syncUtangToSheets_delete(utangId) {
  if (!state.settings.sheetUrl) {
    // Simpan ke tombstone jika tidak ada URL
    try { await saveToStore(STORE_DELETED_IDS, { id: utangId, type: 'utang', deletedAt: new Date().toISOString() }); } catch(e){}
    return;
  }
  // Simpan ke tombstone dulu sebelum coba kirim
  try { await saveToStore(STORE_DELETED_IDS, { id: utangId, type: 'utang', deletedAt: new Date().toISOString() }); } catch(e){}
  try {
    await fetch(state.settings.sheetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ action: 'delete_utang', id: utangId })
    });
    // Berhasil → hapus dari tombstone
    try { await deleteFromStore(STORE_DELETED_IDS, utangId); } catch(e){}
  } catch (err) {
    console.error('Gagal hapus utang dari Sheet, akan dicoba ulang saat startup:', err);
    // Tombstone tetap tersimpan untuk retry berikutnya
  }
}

function renderDashboardQuickUtang() {
  const tbody = document.getElementById('dashboard-utang-quick-tbody');
  if (!tbody) return;
  
  tbody.innerHTML = '';
  const pendingUtang = (state.utang || []).filter(u => u.status === 'BELUM_LUNAS');
  
  if (pendingUtang.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted">Tidak ada utang yang belum lunas. 🎉</td></tr>';
    return;
  }
  
  pendingUtang.slice(0, 5).forEach(u => {
    const tr = document.createElement('tr');
    const typeBadge = u.tipe === 'IN' 
      ? '<span class="badge-type in">Piutang</span>' 
      : '<span class="badge-type out">Utang</span>';
      
    tr.innerHTML = `
      <td class="text-center">
        <label class="custom-checkbox-container" title="Centang untuk melunasi langsung dari Dashboard">
          <input type="checkbox" class="dash-utang-chk" data-id="${u.id}">
          <span class="custom-checkbox-checkmark"></span>
        </label>
      </td>
      <td>${formatIndonesianDate(u.tanggal)}</td>
      <td>${typeBadge}</td>
      <td class="font-bold">${u.nama}</td>
      <td>${u.sumberDana || '-'}</td>
      <td class="font-bold ${u.tipe === 'IN' ? 'text-success' : 'text-danger'}">${formatRupiah(u.nominal)}</td>
      <td>${u.keterangan}</td>
    `;
    
    const chk = tr.querySelector('.dash-utang-chk');
    chk.addEventListener('change', (e) => {
      toggleUtangStatus(u.id, e.target.checked);
    });
    
    tbody.appendChild(tr);
  });
}

// ================= ALOKASI DANA TALANGAN HANDLERS =================
function setupAlokasiTalanganModal() {
  const modal = document.getElementById('modal-alokasi-talangan');
  const btnClose = document.getElementById('btn-close-alokasi-modal');
  const btnCancel = document.getElementById('btn-cancel-alokasi-modal');
  const btnSubmit = document.getElementById('btn-submit-alokasi-modal');
  
  if (btnClose) btnClose.addEventListener('click', () => modal.classList.remove('active'));
  if (btnCancel) btnCancel.addEventListener('click', () => modal.classList.remove('active'));
  
  if (btnSubmit) {
    btnSubmit.addEventListener('click', async () => {
      const txnId = document.getElementById('alokasi-txn-id').value;
      const targetSumber = document.getElementById('alokasi-sumber-select').value;
      
      if (!targetSumber) {
        showToast('Pilih Sumber Dana', 'Pilih sumber dana tujuan alokasi.', 'error');
        return;
      }
      
      await alokasikanNotaTalangan(txnId, targetSumber);
      modal.classList.remove('active');
    });
  }
}

function openAlokasiTalanganModal(txnId) {
  const modal = document.getElementById('modal-alokasi-talangan');
  if (!modal) return;
  document.getElementById('alokasi-txn-id').value = txnId;
  populateDropdowns();
  modal.classList.add('active');
}

async function alokasikanNotaTalangan(txnId, targetSumber) {
  const txn = state.transactions.find(t => t.id === txnId);
  if (!txn) return;
  
  txn.sumberDana = targetSumber;
  txn.kategoriSumber = targetSumber;
  txn.sync = false;
  
  await saveToStore(STORE_TXNS, txn);
  if (state.settings.autoSync && state.settings.sheetUrl) {
    syncTransactionToSheets(txn);
  }
  
  showToast('Dana Talangan Dialokasikan', `Transaksi ${txn.id} kini resmi dialokasikan ke ${targetSumber}.`, 'success');
  renderApp();
}

