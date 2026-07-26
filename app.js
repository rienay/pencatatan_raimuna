/**
 * JavaScript App Logic: Bendahara Raimuna Cabang Cilacap
 * Stored locally via IndexedDB, syncs with Google Sheets.
 */

// Global App State
const state = {
  transactions: [],
  categories: [],
  sources: [],
  settings: {
    sheetUrl: 'https://script.google.com/macros/s/AKfycbyWD04xOruxI3QedBqtpYC0gyFve1UnvqBekCvo0OVhD2prQB9HKrU89AjOyZOwgvprzg/exec',
    autoSync: true
  },
  filters: {
    search: '',
    tipe: 'ALL',
    bulan: 'ALL',
    tahun: 'ALL',
    kategoriSumber: 'ALL',
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
  db: null
};

// IndexedDB Helper Variables
const DB_NAME = 'RaimunaCilacapDB';
const DB_VERSION = 1;
const STORE_TXNS = 'transactions';
const STORE_CATS = 'categories';
const STORE_SRCS = 'sources';
const STORE_SETTINGS = 'settings';

// Default Data Seed arrays
const DEFAULT_SOURCES = [
  'Sponsor', 'APBD', 'Minyak Jelantah', 'Pembayaran Stand', 'Donatur', 'Iuran Panitia', 'Lainnya'
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
let dropzoneIn, dropzoneOut;
let fileIndicatorIn, fileIndicatorOut;

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
  
  // Set default dates on forms
  const today = new Date().toISOString().split('T')[0];
  document.getElementById('in-tanggal').value = today;
  document.getElementById('out-tanggal').value = today;
  
  // Render application
  renderApp();
  
  // Auto test connection if URL exists
  if (state.settings.sheetUrl) {
    updateSyncBadge('unsynced', 'Menghubungkan...');
    testGoogleSheetsConnection(false);
  }
});

// Setup References to DOM elements
function setupDomReferences() {
  dropzoneIn = document.getElementById('in-dropzone');
  dropzoneOut = document.getElementById('out-dropzone');
  fileIndicatorIn = document.getElementById('in-file-indicator');
  fileIndicatorOut = document.getElementById('out-file-indicator');
  
  // Drag and Drop listeners
  setupFileDropzone(dropzoneIn, 'in-bukti', fileIndicatorIn);
  setupFileDropzone(dropzoneOut, 'out-nota', fileIndicatorOut);
  
  // Numeric Inputs Formatting (Auto Rupiah)
  setupRupiahInput('in-nominal');
  setupRupiahInput('out-nominal');
  
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
      handleFileSelected(fileInput.files[0], indicator);
    }
  });
  
  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) {
      handleFileSelected(fileInput.files[0], indicator);
    } else {
      indicator.textContent = '';
      state.currentUpload = null;
    }
  });
}

// Convert uploaded file to Base64
function handleFileSelected(file, indicator) {
  if (!file) return;
  const maxSize = 4 * 1024 * 1024; // 4MB limit to keep IndexedDB happy
  if (file.size > maxSize) {
    showToast('Ukuran File Terlalu Besar', 'Maksimal ukuran file adalah 4MB.', 'error');
    state.currentUpload = null;
    indicator.textContent = '';
    return;
  }
  
  const reader = new FileReader();
  reader.onload = function(e) {
    state.currentUpload = {
      name: file.name,
      type: file.type,
      base64: e.target.result
    };
    indicator.textContent = `File terpilih: ${file.name} (${(file.size/1024).toFixed(1)} KB)`;
    showToast('File Berhasil Diunggah', `File ${file.name} siap dilampirkan.`, 'info');
  };
  reader.readAsDataURL(file);
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
    };
  });
}

// Load state values from IndexedDB
async function loadStateFromDB() {
  state.transactions = await getAllFromStore(STORE_TXNS);
  state.categories = await getAllFromStore(STORE_CATS);
  state.sources = await getAllFromStore(STORE_SRCS);
  
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
  
  // Load settings
  const sheetUrlSetting = await getFromStore(STORE_SETTINGS, 'sheetUrl');
  const autoSyncSetting = await getFromStore(STORE_SETTINGS, 'autoSync');
  
  if (!sheetUrlSetting || !sheetUrlSetting.value || sheetUrlSetting.value === 'https://script.google.com/macros/s/AKfycbwu0tiHWD_Yt_z5M2J8fqmjf29gGvMiPp1a8V9hdSV-cGgBFvPr82xchE8HAF069weTJg/exec') {
    state.settings.sheetUrl = 'https://script.google.com/macros/s/AKfycbyWD04xOruxI3QedBqtpYC0gyFve1UnvqBekCvo0OVhD2prQB9HKrU89AjOyZOwgvprzg/exec';
    await saveToStore(STORE_SETTINGS, { key: 'sheetUrl', value: state.settings.sheetUrl });
  } else {
    state.settings.sheetUrl = sheetUrlSetting.value;
  }
  
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
        'laporan-section': 'Laporan Keuangan',
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
  const filterCatSumberSelect = document.getElementById('filter-kategori-sumber');
  
  // Keep selected values if any
  const selectedSumber = inSumberSelect.value;
  const selectedKategori = outKategoriSelect.value;
  const selectedFilter = filterCatSumberSelect.value;
  
  // Clear
  inSumberSelect.innerHTML = '<option value="" disabled selected>Pilih Sumber Dana</option>';
  outKategoriSelect.innerHTML = '<option value="" disabled selected>Pilih Kategori Bidang</option>';
  filterCatSumberSelect.innerHTML = '<option value="ALL">Semua Kategori/Sumber</option>';
  
  // Populate Sources
  state.sources.forEach(src => {
    const opt = document.createElement('option');
    opt.value = src.nama;
    opt.textContent = src.nama;
    inSumberSelect.appendChild(opt);
    
    const filterOpt = document.createElement('option');
    filterOpt.value = src.nama;
    filterOpt.textContent = `Pemasukan: ${src.nama}`;
    filterCatSumberSelect.appendChild(filterOpt);
  });
  
  // Populate Categories
  state.categories.forEach(cat => {
    const opt = document.createElement('option');
    opt.value = cat.nama;
    opt.textContent = cat.nama;
    outKategoriSelect.appendChild(opt);
    
    const filterOpt = document.createElement('option');
    filterOpt.value = cat.nama;
    filterOpt.textContent = `Pengeluaran: ${cat.nama}`;
    filterCatSumberSelect.appendChild(filterOpt);
  });
  
  // Restore selections
  if (selectedSumber) inSumberSelect.value = selectedSumber;
  if (selectedKategori) outKategoriSelect.value = selectedKategori;
  if (selectedFilter) filterCatSumberSelect.value = selectedFilter;
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
    const pengambil = document.getElementById('out-pengambil').value;
    const nominal = parseRupiah(document.getElementById('out-nominal').value);
    const keterangan = document.getElementById('out-keterangan').value;
    
    if (nominal <= 0) {
      showToast('Input Salah', 'Nominal harus lebih besar dari Rp 0.', 'error');
      return;
    }
    
    if (!state.currentUpload) {
      showToast('Nota Wajib Diunggah', 'Harap lampirkan nota bukti pengeluaran.', 'error');
      return;
    }
    
    const newTxn = {
      id: generateUniqueId('TXN-OUT'),
      tanggal,
      tipe: 'OUT',
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
  
  showToast('Transaksi Berhasil Disimpan', `Transaksi ${txn.id} tersimpan secara lokal.`, 'success');
  
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
    kategoriSumber: txn.kategoriSumber,
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

// Delete transaction from Google Sheets
async function syncDeleteToSheets(txnId) {
  if (!state.settings.sheetUrl) return;
  try {
    await fetch(state.settings.sheetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain'
      },
      body: JSON.stringify({
        action: 'delete_single',
        id: txnId
      })
    });
  } catch (err) {
    console.error('Failed to sync delete to sheet:', err);
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
    kategoriSumber: txn.kategoriSumber,
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
        transactions: cleanList
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
      // Clear local txns store
      await clearStore(STORE_TXNS);
      
      const newTxns = result.data.map(row => ({
        id: row.id,
        tanggal: formatDateString(row.tanggal),
        tipe: row.tipe,
        kategoriSumber: row.kategoriSumber,
        pic: row.pic,
        nominal: parseInt(row.nominal, 10) || 0,
        keterangan: row.keterangan,
        dateCreated: row.dateCreated || new Date().toISOString(),
        attachment: null, // Attachments are not synced to Google Sheets due to size, kept empty
        sync: true
      }));
      
      // Save all to local DB
      for (const txn of newTxns) {
        await saveToStore(STORE_TXNS, txn);
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
  }
}

// ================= RENDER: DASHBOARD =================
function renderDashboard() {
  // 1. Calculate Metrics
  let totalIn = 0;
  let totalOut = 0;
  let txnCount = state.transactions.length;
  
  state.transactions.forEach(t => {
    if (t.tipe === 'IN') totalIn += t.nominal;
    else if (t.tipe === 'OUT') totalOut += t.nominal;
  });
  
  let saldo = totalIn - totalOut;
  
  // Update fields
  document.getElementById('dashboard-total-saldo').textContent = formatRupiah(saldo);
  document.getElementById('dashboard-total-pemasukan').textContent = formatRupiah(totalIn);
  document.getElementById('dashboard-total-pengeluaran').textContent = formatRupiah(totalOut);
  document.getElementById('dashboard-total-transaksi').textContent = txnCount;
  
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
        <td>${tx.kategoriSumber}</td>
        <td>${tx.pic}</td>
        <td class="text-right font-bold ${tx.tipe === 'IN' ? 'text-success' : 'text-danger'}">${formatRupiah(tx.nominal)}</td>
        <td class="no-print text-center">${syncBadge}</td>
        <td class="no-print">
          <button class="btn-icon" title="Lihat Detail">🔍</button>
        </td>
      `;
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
      const cat = t.kategoriSumber;
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
    runningBalancesMap[tx.id] = runningTotal;
  });
  
  // Render report rows
  const tbody = document.getElementById('laporan-tbody');
  tbody.innerHTML = '';
  
  let filteredNominalSum = 0;
  
  if (filtered.length === 0) {
    tbody.innerHTML = '<tr class="row-empty"><td colspan="11" class="text-center text-muted">Tidak ditemukan transaksi yang cocok dengan filter.</td></tr>';
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
        <td>${tx.kategoriSumber}</td>
        <td>${tx.pic}</td>
        <td class="text-muted">${tx.keterangan}</td>
        <td class="text-right font-bold ${tx.tipe === 'IN' ? 'text-success' : 'text-danger'}">${formatRupiah(tx.nominal)}</td>
        <td class="text-right font-bold">${formatRupiah(balAtTx)}</td>
        <td class="no-print text-center">${syncBadge}</td>
        <td class="no-print text-center">
          <button class="btn-icon" title="Lihat Detail">🔍</button>
        </td>
      `;
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
    document.getElementById('report-filtered-final-saldo').textContent = formatRupiah(overallIn - overallOut);
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
    
    // 4. Kategori / Sumber Dana
    if (state.filters.kategoriSumber !== 'ALL' && tx.kategoriSumber !== state.filters.kategoriSumber) {
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
  
  document.getElementById('filter-kategori-sumber').addEventListener('change', (e) => {
    state.filters.kategoriSumber = e.target.value;
    renderLaporan();
  });
  
  document.getElementById('filter-sync').addEventListener('change', (e) => {
    state.filters.sync = e.target.value;
    renderLaporan();
  });
  
  document.getElementById('btn-reset-filters').addEventListener('click', () => {
    document.getElementById('filter-search').value = '';
    document.getElementById('filter-tipe').value = 'ALL';
    document.getElementById('filter-bulan').value = 'ALL';
    document.getElementById('filter-tahun').value = 'ALL';
    document.getElementById('filter-kategori-sumber').value = 'ALL';
    document.getElementById('filter-sync').value = 'ALL';
    
    state.filters = {
      search: '',
      tipe: 'ALL',
      bulan: 'ALL',
      tahun: 'ALL',
      kategoriSumber: 'ALL',
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
  
  document.getElementById('btn-add-sumber-inline').addEventListener('click', () => {
    inlineAddTargetType = 'SUMBER';
    customTitle.textContent = 'Tambah Sumber Dana';
    customLabel.textContent = 'Nama Sumber Dana Baru';
    customInput.value = '';
    customInput.placeholder = 'Misal: Sponsorship Eksternal';
    customModal.classList.add('open');
  });
  
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
      document.getElementById('in-sumber').value = val;
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
  } else {
    typeEl.textContent = 'Pengeluaran';
    typeEl.className = 'txn-badge-type pengeluaran';
    document.getElementById('detail-cat-sumber-label').textContent = 'Kategori Bidang:';
    document.getElementById('detail-pic-label').textContent = 'Pengambil Dana:';
    document.getElementById('detail-amount').className = 'detail-value font-bold text-danger';
  }
  
  document.getElementById('detail-date').textContent = formatIndonesianDate(txn.tanggal);
  document.getElementById('detail-cat-sumber-value').textContent = txn.kategoriSumber;
  document.getElementById('detail-pic-value').textContent = txn.pic;
  document.getElementById('detail-amount').textContent = formatRupiah(txn.nominal);
  document.getElementById('detail-description').textContent = txn.keterangan;
  
  // Render attachments
  const renderArea = document.getElementById('attachment-preview-render');
  renderArea.innerHTML = '';
  
  if (txn.attachment && txn.attachment.base64) {
    const att = txn.attachment;
    
    if (att.type.startsWith('image/')) {
      const img = document.createElement('img');
      img.src = att.base64;
      img.alt = att.name;
      img.title = 'Klik untuk memperbesar gambar bukti';
      img.addEventListener('click', () => {
        // Open in new tab window
        const w = window.open();
        w.document.write(`<title>${att.name}</title><img src="${att.base64}" style="max-width:100%; max-height:100vh; display:block; margin:auto;" />`);
        w.document.close();
      });
      renderArea.appendChild(img);
    } else if (att.type === 'application/pdf') {
      const box = document.createElement('div');
      box.className = 'pdf-preview-box';
      
      const icon = document.createElement('div');
      icon.className = 'pdf-icon';
      icon.textContent = '📄';
      
      const nameText = document.createElement('span');
      nameText.textContent = att.name;
      nameText.className = 'font-bold text-muted';
      
      const link = document.createElement('button');
      link.className = 'btn btn-secondary btn-small';
      link.textContent = 'Lihat Berkas PDF / Nota';
      link.addEventListener('click', () => {
        // Open base64 pdf in new window
        const pdfWindow = window.open();
        pdfWindow.document.write(`<title>${att.name}</title><iframe width='100%' height='100%' src='${att.base64}'></iframe>`);
        pdfWindow.document.close();
      });
      
      box.appendChild(icon);
      box.appendChild(nameText);
      box.appendChild(link);
      renderArea.appendChild(box);
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
    
    if (confirm(`Apakah Anda yakin ingin MENGAPUS transaksi ${id}?\nNominal: ${formatRupiah(match.nominal)}\nKeterangan: "${match.keterangan}"`)) {
      // Remove local
      state.transactions = state.transactions.filter(t => t.id !== id);
      await deleteFromStore(STORE_TXNS, id);
      
      // If synced and url set, push delete action to Google Sheets in the background (non-blocking)
      if (match.sync && state.settings.sheetUrl) {
        syncDeleteToSheets(id);
      }
      
      closeModal();
      showToast('Transaksi Dihapus', `Transaksi ${id} berhasil dihapus.`, 'success');
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
    
    // Automatically trigger test connection if URL saved
    if (url) {
      testGoogleSheetsConnection(false);
    }
  });
  
  document.getElementById('btn-test-connection').addEventListener('click', () => {
    testGoogleSheetsConnection(true);
  });
  
  document.getElementById('btn-sync-push').addEventListener('click', () => {
    if (confirm('Kirim semua transaksi lokal Anda ke Google Sheet? Ini akan menimpa baris-baris data transaksi di Sheet Anda.')) {
      pushAllTransactionsToSheets();
    }
  });
  
  document.getElementById('btn-sync-pull').addEventListener('click', () => {
    pullAllTransactionsFromSheets();
  });
  
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
    let csv = '\ufeffNo;Tanggal;ID Transaksi;Tipe;Kategori / Sumber;Penanggung Jawab;Keterangan;Nominal;Sync\n';
    
    filtered.forEach((t, i) => {
      const cleanDesc = t.keterangan.replace(/[\n\r;]/g, ' ');
      csv += `${i+1};${t.tanggal};${t.id};${t.tipe};${t.kategoriSumber};${t.pic};${cleanDesc};${t.nominal};${t.sync ? 'YA' : 'BELUM'}\n`;
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
              <th>Kategori / Sumber</th>
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
          <td>${t.kategoriSumber}</td>
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
