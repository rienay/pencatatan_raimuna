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
    sheetUrl: 'https://script.google.com/macros/s/AKfycbxgXVSBwxmTECLyJDViwV_Yhg9XkLMx2HV4y-9NpqPtCQUvE1LE7dcezzCgQCSLQdxWNA/exec',
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
  jelantahRecap: [],
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
const STORE_JELANTAH = 'jelantah_recap';
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
  let raw = tx.sumberDana;
  if (!raw || raw === '' || raw === 'ALL') raw = tx.sumber;
  if ((!raw || raw === '' || raw === 'ALL') && tx.tipe === 'IN') raw = tx.kategoriSumber;
  if (!raw) return '-';
  if (raw === 'Pembayaran Stand') return 'Pembayaran Tenant';
  return raw;
}

function parseSheetRow(row) {
  let tipe = row.tipe;
  let kategori = row.kategori;
  let sumberDana = row.sumberDana;
  if (sumberDana === 'Pembayaran Stand') sumberDana = 'Pembayaran Tenant';
  let pic = row.pic;
  let nominal = row.nominal;
  let keterangan = row.keterangan || '-';

  if (!tipe) {
    if (String(row.id || '').indexOf('TXN-IN') !== -1) tipe = 'IN';
    else if (String(row.id || '').indexOf('TXN-OUT') !== -1) tipe = 'OUT';
    else tipe = 'IN';
  }

  const rawPic = String(pic || '').trim();
  const rawNominal = row.nominal;

  const blankCol = row[''];
  if (/^\d+$/.test(rawPic) && (isNaN(nominal) || !/^\d+$/.test(rawNominal))) {
    nominal = parseInt(rawPic, 10) || 0;
    pic = blankCol ? String(blankCol).trim() : '-';
    keterangan = row.nominal ? String(row.nominal).trim() : keterangan;
  } else {
    nominal = isNaN(nominal) ? (parseInt(rawNominal, 10) || 0) : nominal;
  }

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

  let attachment = null;
  const rawBukti = row.bukti || row.Bukti || row.lampiran || row.Lampiran || row.attachment || row.Attachment;
  if (rawBukti) {
    if (Array.isArray(rawBukti)) {
      attachment = rawBukti;
    } else {
      const urls = String(rawBukti).split(',').map(s => s.trim()).filter(Boolean);
      if (urls.length > 0) attachment = urls;
    }
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
    attachment: attachment,
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

  let attachment = null;
  const rawBukti = row.bukti || row.Bukti || row.lampiran || row.Lampiran || row.attachment || row.Attachment;
  if (rawBukti) {
    if (Array.isArray(rawBukti)) {
      attachment = rawBukti;
    } else {
      const urls = String(rawBukti).split(',').map(s => s.trim()).filter(Boolean);
      if (urls.length > 0) attachment = urls;
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
    attachment: attachment,
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
let dropzoneIn, dropzoneOut, dropzoneEdit, dropzoneAmbil;
let fileIndicatorIn, fileIndicatorOut, fileIndicatorEdit, fileIndicatorAmbil;

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
  setupJelantahHandlers();

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

  // Auto re-sync saat user kembali fokus ke tab/window (misal setelah input data dari HP)
  window.addEventListener('focus', async () => {
    if (state.settings.sheetUrl && state.settings.autoSync) {
      await pushPendingDeletes();
      await autoSyncPendingTransactions();
      await autoPullFromSheets();
    }
  });

  // Auto polling berkala setiap 30 detik agar data HP & Laptop selalu sinkron otomatis tanpa perlu refresh manual
  setInterval(async () => {
    if (state.settings.sheetUrl && state.settings.autoSync && document.visibilityState === 'visible') {
      await pushPendingDeletes();
      await autoSyncPendingTransactions();
      await autoPullFromSheets();
    }
  }, 30000);
});

let fileIndicatorKwitansiUpload = null;

// Setup References to DOM elements
function setupDomReferences() {
  dropzoneIn = document.getElementById('in-dropzone');
  dropzoneOut = document.getElementById('out-dropzone');
  dropzoneEdit = document.getElementById('edit-dropzone');
  dropzoneAmbil = document.getElementById('ambil-dropzone');
  fileIndicatorIn = document.getElementById('in-file-indicator');
  fileIndicatorOut = document.getElementById('out-file-indicator');
  fileIndicatorEdit = document.getElementById('edit-file-indicator');
  fileIndicatorAmbil = document.getElementById('ambil-file-indicator');

  const dropzoneKw = document.getElementById('kwitansi-upload-dropzone');
  fileIndicatorKwitansiUpload = document.getElementById('kwitansi-file-indicator');

  // Drag and Drop listeners
  if (dropzoneIn) setupFileDropzone(dropzoneIn, 'in-bukti', fileIndicatorIn);
  if (dropzoneOut) setupFileDropzone(dropzoneOut, 'out-nota', fileIndicatorOut);
  if (dropzoneEdit) setupFileDropzone(dropzoneEdit, 'edit-bukti', fileIndicatorEdit);
  if (dropzoneAmbil) setupFileDropzone(dropzoneAmbil, 'ambil-bukti', fileIndicatorAmbil);
  if (dropzoneKw) setupFileDropzone(dropzoneKw, 'kwitansi-upload-file', fileIndicatorKwitansiUpload);

  // Numeric Inputs Formatting (Auto Rupiah)
  setupRupiahInput('in-nominal');
  setupRupiahInput('out-nominal');
  setupRupiahInput('ambil-nominal');
  setupRupiahInput('utang-nominal');

  // Sidebar responsive toggle
  const sidebar = document.querySelector('.sidebar');
  const toggleBtn = document.getElementById('sidebar-toggle');

  if (toggleBtn && sidebar) {
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
}

// Setup File drag and drop dropzone logic
function setupFileDropzone(dropzone, inputId, indicator) {
  const fileInput = document.getElementById(inputId);
  if (!dropzone || !fileInput) return;

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
      if (indicator) indicator.textContent = '';
      state.currentUpload = null;
    }
  });
}

// Smart Client-side Image Compression (Canvas-based)
async function compressImageFile(file) {
  if (!file) return null;
  // If not image (e.g. PDF), read directly as Base64 Data URL
  if (!file.type || !file.type.startsWith('image/') || file.type === 'image/svg+xml') {
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => resolve({ name: file.name, type: file.type || 'application/pdf', base64: e.target.result });
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    });
  }

  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const maxWidth = 1920;
        const maxHeight = 1920;
        let width = img.width;
        let height = img.height;

        if (width > maxWidth || height > maxHeight) {
          if (width > height) {
            height = Math.round((height * maxWidth) / width);
            width = maxWidth;
          } else {
            width = Math.round((width * maxHeight) / height);
            height = maxHeight;
          }
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);

        const compressedBase64 = canvas.toDataURL('image/jpeg', 0.82);
        resolve({
          name: file.name.replace(/\.[^/.]+$/, "") + ".jpg",
          type: 'image/jpeg',
          base64: compressedBase64
        });
      };
      img.onerror = () => {
        resolve({ name: file.name, type: file.type || 'image/jpeg', base64: e.target.result });
      };
      img.src = e.target.result;
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

// Convert uploaded files to array of Base64 objects with auto compression and accumulation
async function handleMultipleFilesSelected(files, indicator) {
  if (!files || files.length === 0) return;
  const filesArray = Array.from(files);
  if (indicator) indicator.innerHTML = `<span style="color: var(--text-muted); font-size: 0.85rem;">Memproses & mengoptimalkan ${filesArray.length} berkas...</span>`;

  const newUploads = [];
  for (const file of filesArray) {
    try {
      const item = await compressImageFile(file);
      if (item && item.base64) {
        newUploads.push(item);
      }
    } catch (err) {
      console.warn('Gagal memproses berkas:', file.name, err);
    }
  }

  // Akumulasi berkas (jika sudah ada sebelumnya, tambahkan berkas baru)
  let currentList = [];
  if (state.currentUpload) {
    currentList = Array.isArray(state.currentUpload) ? [...state.currentUpload] : [state.currentUpload];
  }

  for (const item of newUploads) {
    if (!currentList.some(ex => ex.name === item.name && ex.base64 === item.base64)) {
      currentList.push(item);
    }
  }

  finishUploadProcessing(currentList, indicator);
}

function removeUploadedFileIndex(index, indicatorId) {
  if (!state.currentUpload) return;
  let list = Array.isArray(state.currentUpload) ? [...state.currentUpload] : [state.currentUpload];
  list.splice(index, 1);
  const indicator = document.getElementById(indicatorId);
  finishUploadProcessing(list, indicator);
}

function clearCurrentUploads(indicatorId) {
  state.currentUpload = null;
  const indicator = document.getElementById(indicatorId);
  if (indicator) {
    indicator.innerHTML = '';
  }
}

window.removeUploadedFileIndex = removeUploadedFileIndex;
window.clearCurrentUploads = clearCurrentUploads;

function finishUploadProcessing(uploads, indicator) {
  if (uploads && uploads.length > 0) {
    state.currentUpload = uploads; // Array of { name, type, base64 }
    if (indicator) {
      const indId = indicator.id || 'indicator';
      indicator.innerHTML = `
        <div style="margin-top: 8px; display: flex; flex-direction: column; gap: 6px; align-items: center; width: 100%;">
          <div style="font-weight: 700; color: var(--success, #10b981); font-size: 0.88rem;">
            ✓ ${uploads.length} berkas foto/nota siap disimpan
          </div>
          <div style="display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; max-width: 100%;">
            ${uploads.map((u, i) => `
              <span style="display: inline-flex; align-items: center; gap: 4px; background: #e0f2fe; color: #0369a1; border: 1px solid #bae6fd; padding: 3px 8px; border-radius: 6px; font-size: 0.75rem; font-weight: 600;">
                📎 ${u.name.length > 18 ? u.name.substring(0, 15) + '...' : u.name}
                <button type="button" onclick="event.stopPropagation(); removeUploadedFileIndex(${i}, '${indId}')" style="background: none; border: none; color: #ef4444; font-weight: bold; cursor: pointer; padding: 0 2px; font-size: 0.9rem;" title="Hapus foto ini">&times;</button>
              </span>
            `).join('')}
          </div>
          <div style="display: flex; gap: 12px; margin-top: 4px; font-size: 0.75rem;">
            <span style="color: #6366f1; font-weight: 600;">+ Klik / seret lagi untuk menambah foto</span>
            <button type="button" onclick="event.stopPropagation(); clearCurrentUploads('${indId}')" style="background: none; border: none; color: #ef4444; text-decoration: underline; cursor: pointer; font-size: 0.75rem;">Hapus Semua</button>
          </div>
        </div>
      `;
    }
    showToast('Berkas Siap', `${uploads.length} berkas foto/nota siap disimpan.`, 'info');
  } else {
    state.currentUpload = null;
    if (indicator) {
      indicator.innerHTML = '';
    }
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

      // Jelantah Recap store
      if (!db.objectStoreNames.contains(STORE_JELANTAH)) {
        db.createObjectStore(STORE_JELANTAH, { keyPath: 'id' });
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
    } catch (e) { }
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
    } catch (e) { }
  }

  try {
    state.jelantahRecap = await getAllFromStore(STORE_JELANTAH);
  } catch (err) {
    state.jelantahRecap = [];
  }

  if (!state.jelantahRecap || state.jelantahRecap.length === 0) {
    try {
      const savedJelantah = localStorage.getItem('jelantah_recap_data');
      if (savedJelantah) state.jelantahRecap = JSON.parse(savedJelantah);
    } catch (e) { }
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

  // ALWAYS force the latest sheet URL from code to avoid cached obsolete URLs
  const hardcodedUrl = 'https://script.google.com/macros/s/AKfycbx3qo3XCHQjO9fDkX8jR81ogZqKDARA7E05Ey1s6iRkPBKoL-qzbNm3yFGkqAGQa5nE/exec';
  state.settings.sheetUrl = hardcodedUrl;
  await saveToStore(STORE_SETTINGS, { key: 'sheetUrl', value: hardcodedUrl });

  if (autoSyncSetting === null || autoSyncSetting === undefined) {
    state.settings.autoSync = true;
    await saveToStore(STORE_SETTINGS, { key: 'autoSync', value: true });
  } else {
    state.settings.autoSync = autoSyncSetting.value;
  }

  // Populate settings form fields safely
  const elSheetUrl = document.getElementById('settings-sheet-url');
  if (elSheetUrl) elSheetUrl.value = state.settings.sheetUrl;

  const elAutoSync = document.getElementById('settings-auto-sync');
  if (elAutoSync) elAutoSync.checked = state.settings.autoSync;
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
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
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
        'jelantah-section': 'Recap Pengambilan Minyak Jelantah',
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
      } else if (targetSectionId === 'jelantah-section') {
        renderJelantahSection();
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
  const ambilKategoriSelect = document.getElementById('ambil-kategori');
  const ambilSumberSelect = document.getElementById('ambil-sumber');
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
  const selectedAmbilKat = ambilKategoriSelect ? ambilKategoriSelect.value : '';
  const selectedAmbilSumber = ambilSumberSelect ? ambilSumberSelect.value : '';
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
  if (ambilKategoriSelect) ambilKategoriSelect.innerHTML = '<option value="" disabled selected>Pilih Bidang</option>';
  if (ambilSumberSelect) ambilSumberSelect.innerHTML = '<option value="" disabled selected>Pilih Sumber Dana</option>';
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

    if (ambilSumberSelect) {
      const optAmbil = document.createElement('option');
      optAmbil.value = src.nama;
      optAmbil.textContent = src.nama;
      ambilSumberSelect.appendChild(optAmbil);
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

    if (ambilKategoriSelect) {
      const optAmbilKat = document.createElement('option');
      optAmbilKat.value = cat.nama;
      optAmbilKat.textContent = cat.nama;
      ambilKategoriSelect.appendChild(optAmbilKat);
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
  if (selectedAmbilKat && ambilKategoriSelect) ambilKategoriSelect.value = selectedAmbilKat;
  if (selectedAmbilSumber && ambilSumberSelect) ambilSumberSelect.value = selectedAmbilSumber;
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

  // Pengambilan Uang Form Submit
  const formAmbil = document.getElementById('form-pengambilan');
  if (formAmbil) {
    formAmbil.addEventListener('submit', async (e) => {
      e.preventDefault();

      const tanggal = document.getElementById('ambil-tanggal').value;
      const kategori = document.getElementById('ambil-kategori').value;
      const sumberDana = document.getElementById('ambil-sumber').value;
      const nama = document.getElementById('ambil-nama').value;
      const nominal = parseRupiah(document.getElementById('ambil-nominal').value);
      const keterangan = document.getElementById('ambil-keterangan').value;

      if (nominal <= 0) {
        showToast('Input Salah', 'Nominal harus lebih besar dari Rp 0.', 'error');
        return;
      }

      if (!state.currentUpload || state.currentUpload.length === 0) {
        showToast('Input Kurang', 'Dokumentasi pengambilan wajib dilampirkan.', 'error');
        return;
      }

      const newTxn = {
        id: generateUniqueId('TXN-OUT'), // Saved identically to normal Pengeluaran
        tanggal,
        tipe: 'OUT',
        kategori: kategori,
        sumberDana: sumberDana,
        kategoriSumber: kategori,
        pic: nama,
        nominal,
        keterangan: `[PENGAMBILAN] ${keterangan}`,
        attachment: state.currentUpload,
        dateCreated: new Date().toISOString(),
        sync: false
      };

      await saveTransaction(newTxn);

      formAmbil.reset();
      document.getElementById('ambil-tanggal').value = new Date().toISOString().split('T')[0];
      const indicator = document.getElementById('ambil-file-indicator');
      if (indicator) indicator.textContent = '';
      state.currentUpload = null;
    });
  }

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
      try { await saveToStore(STORE_UTANG, autoUtang); } catch (e) { }
      try { localStorage.setItem('raimuna_utang_data', JSON.stringify(state.utang)); } catch (e) { }
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
    attachment: txn.attachment,
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

    try {
      const res = await response.json();
      if (res.urls && res.urls.length > 0) {
        txn.attachment = res.urls;
        await saveToStore(STORE_TXNS, txn);
      }
    } catch (e) {}

    txn.sync = true;
    await saveToStore(STORE_TXNS, txn);
    updateSyncBadgeState();

    // Check if still in transaction list, update sync flag in state
    const match = state.transactions.find(t => t.id === txn.id);
    if (match) {
      match.sync = true;
      if (txn.attachment) match.attachment = txn.attachment;
    }

    showToast('Tersinkronisasi', `Transaksi ${txn.id} berhasil diunggah ke Google Drive & Sheets.`, 'success');
  } catch (err) {
    showToast('Gagal Sinkronisasi', 'Gagal mengirim data ke Google Sheets.', 'error');
    updateSyncBadge('error', 'Gagal Sinkronisasi');
  }
}

// Delete transaction from Google Sheets dengan tombstone pattern
async function syncDeleteToSheets(txnId) {
  if (!state.settings.sheetUrl) {
    try { await saveToStore(STORE_DELETED_IDS, { id: txnId, type: 'transaction', deletedAt: new Date().toISOString() }); } catch (e) { }
    return;
  }
  try { await saveToStore(STORE_DELETED_IDS, { id: txnId, type: 'transaction', deletedAt: new Date().toISOString() }); } catch (e) { }
  try {
    await fetch(state.settings.sheetUrl, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ action: 'delete_single', id: txnId })
    });
    try { await deleteFromStore(STORE_DELETED_IDS, txnId); } catch (e) { }
  } catch (err) {
    console.error('Gagal hapus dari Sheet, akan dicoba ulang saat startup:', err);
  }
}

// Kirim semua transaksi lokal yang belum tersinkronisasi (sync === false) ke Google Sheets
async function autoSyncPendingTransactions() {
  if (!state.settings.sheetUrl) return;
  const unsyncedTxns = (state.transactions || []).filter(t => !t.sync);
  if (!unsyncedTxns || unsyncedTxns.length === 0) return;

  for (const txn of unsyncedTxns) {
    try {
      await syncTransactionToSheets(txn);
    } catch (err) {
      console.error('Gagal auto-sync transaksi:', txn.id, err);
    }
  }
}

// Kirim semua pending deletes ke Google Sheets (dipanggil saat startup)
async function pushPendingDeletes() {
  if (!state.settings.sheetUrl) return;
  let pendingDeletes = [];
  try { pendingDeletes = await getAllFromStore(STORE_DELETED_IDS); } catch (e) { return; }
  if (!pendingDeletes || pendingDeletes.length === 0) return;

  for (const item of pendingDeletes) {
    try {
      if (item.type === 'utang') {
        await fetch(state.settings.sheetUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: JSON.stringify({ action: 'delete_utang', id: item.id })
        });
      } else if (item.type === 'jelantah') {
        await fetch(state.settings.sheetUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: JSON.stringify({ action: 'delete_jelantah', id: item.id })
        });
        await fetch(state.settings.sheetUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: JSON.stringify({ action: 'delete_kwitansi', id: item.id })
        });
      } else if (item.type === 'kwitansi') {
        await fetch(state.settings.sheetUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: JSON.stringify({ action: 'delete_kwitansi', id: item.id, no: item.no || '' })
        });
      } else {
        await fetch(state.settings.sheetUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: JSON.stringify({ action: 'delete_single', id: item.id })
        });
      }
      try { await deleteFromStore(STORE_DELETED_IDS, item.id); } catch (e) { }
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
      mode: 'no-cors',
      headers: {
        'Content-Type': 'text/plain'
      },
      body: JSON.stringify({
        action: 'push_bulk',
        transactions: cleanList,
        kwitansi: state.sponsorshipHistory || [],
        utang: state.utang || [],
        jelantah: state.jelantahRecap || []
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
      // Simpan semua attachment lokal sebelum diganti
      const localAttachmentMap = {};
      for (const txn of state.transactions) {
        if (txn.attachment && txn.id) {
          localAttachmentMap[txn.id] = txn.attachment;
        }
      }

      // Simpan attachment lokal kwitansi sebelum diganti
      const localKwAttachmentMapPull = {};
      for (const kw of (state.sponsorshipHistory || [])) {
        if (kw.attachment && kw.id) {
          localKwAttachmentMapPull[kw.id] = kw.attachment;
        }
      }

      // Clear local txns store
      await clearStore(STORE_TXNS);

      const newTxns = result.data.map(parseSheetRow);

      // Kembalikan attachment lokal jika data sheet belum memiliki bukti
      for (const txn of newTxns) {
        if (!txn.attachment && localAttachmentMap[txn.id]) {
          txn.attachment = localAttachmentMap[txn.id];
        }
      }

      // Save all to local DB
      for (const txn of newTxns) {
        await saveToStore(STORE_TXNS, txn);
      }

      if (result.kwitansi && Array.isArray(result.kwitansi) && result.kwitansi.length > 0) {
        const parsedKw = result.kwitansi.map(parseKwitansiRow).filter(Boolean);
        for (const kw of parsedKw) {
          if (!kw.attachment && localKwAttachmentMapPull[kw.id]) {
            kw.attachment = localKwAttachmentMapPull[kw.id];
          }
        }
        state.sponsorshipHistory = parsedKw;
        try {
          await clearStore(STORE_SPONSORSHIPS);
          for (const kw of parsedKw) {
            await saveToStore(STORE_SPONSORSHIPS, kw);
          }
          localStorage.setItem('sponsorship_history', JSON.stringify(state.sponsorshipHistory));
        } catch (e) { }
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
        } catch (e) { }
      }

      // Ganti data jelantah recap sepenuhnya (kombinasi dari result.jelantah dan kwitansi tipe Jelantah)
      const localJelantahAttachmentMapPull = {};
      for (const jlt of (state.jelantahRecap || [])) {
        if (jlt.attachment && jlt.id) {
          localJelantahAttachmentMapPull[jlt.id] = jlt.attachment;
        }
      }

      let pendingDeletesPull = [];
      try { pendingDeletesPull = await getAllFromStore(STORE_DELETED_IDS); } catch (e) { }
      const deletedJelantahIdsPull = (pendingDeletesPull || []).filter(d => d.type === 'jelantah' || d.type === 'kwitansi').map(d => String(d.id).trim());

      let rawJelantahPull = Array.isArray(result.jelantah) ? [...result.jelantah] : [];
      if (result.kwitansi && Array.isArray(result.kwitansi)) {
        const kwJlt = result.kwitansi.filter(row => {
          const tipe = String(row.Tipe || row.tipeJenis || row['No. Kwitansi'] || row['Tipe Jenis'] || row.guna || row.Keperluan || '').toUpperCase();
          return tipe.includes('JELANTAH');
        });
        rawJelantahPull = [...rawJelantahPull, ...kwJlt];
      }

      if (rawJelantahPull.length > 0) {
        const mapJlt = new Map();
        rawJelantahPull.forEach(row => {
          const parsed = parseJelantahRow(row);
          if (parsed && parsed.id && !deletedJelantahIdsPull.includes(parsed.id)) {
            if (localJelantahAttachmentMapPull[parsed.id] && !parsed.attachment) {
              parsed.attachment = localJelantahAttachmentMapPull[parsed.id];
            }
            mapJlt.set(parsed.id, parsed);
          }
        });
        const parsedJlt = Array.from(mapJlt.values());
        state.jelantahRecap = parsedJlt;
        try {
          await clearStore(STORE_JELANTAH);
          for (const jlt of parsedJlt) {
            await saveToStore(STORE_JELANTAH, jlt);
          }
          localStorage.setItem('jelantah_recap_data', JSON.stringify(state.jelantahRecap));
        } catch (e) { }
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

      let pendingDeletes = [];
      try { pendingDeletes = await getAllFromStore(STORE_DELETED_IDS); } catch (e) { }

      // Simpan semua attachment lokal sebelum diganti
      const localAttachmentMap = {};
      for (const txn of state.transactions) {
        if (txn.attachment && txn.id) {
          localAttachmentMap[txn.id] = txn.attachment;
        }
      }

      // Simpan attachment lokal kwitansi sebelum diganti
      const localKwAttachmentMap = {};
      for (const kw of (state.sponsorshipHistory || [])) {
        if (kw.attachment && kw.id) {
          localKwAttachmentMap[kw.id] = kw.attachment;
        }
      }

      const remoteTxns = result.data.map(parseSheetRow);

      // Kembalikan attachment lokal ke transaksi jika belum ada di sheet
      for (const txn of remoteTxns) {
        if (!txn.attachment && localAttachmentMap[txn.id]) {
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
        for (const kw of parsedKw) {
          if (!kw.attachment && localKwAttachmentMap[kw.id]) {
            kw.attachment = localKwAttachmentMap[kw.id];
          }
        }
        state.sponsorshipHistory = parsedKw;
        try {
          await clearStore(STORE_SPONSORSHIPS);
          for (const kw of parsedKw) {
            await saveToStore(STORE_SPONSORSHIPS, kw);
          }
          localStorage.setItem('sponsorship_history', JSON.stringify(state.sponsorshipHistory));
        } catch (e) { }
      }

      // Ganti data utang sepenuhnya (filter utang yang sedang ada di antrean tombstone hapus)
      if (result.utang && Array.isArray(result.utang)) {
        const deletedUtangIds = (pendingDeletes || []).filter(d => d.type === 'utang').map(d => d.id);

        const parsedUt = result.utang.map(parseUtangRow).filter(Boolean).filter(u => !deletedUtangIds.includes(u.id));
        state.utang = parsedUt;
        try {
          await clearStore(STORE_UTANG);
          for (const ut of parsedUt) {
            await saveToStore(STORE_UTANG, ut);
          }
          localStorage.setItem('raimuna_utang_data', JSON.stringify(state.utang));
        } catch (e) { }
      }

      // Simpan attachment lokal jelantah sebelum diganti
      const localJelantahAttachmentMap = {};
      for (const jlt of (state.jelantahRecap || [])) {
        if (jlt.attachment && jlt.id) {
          localJelantahAttachmentMap[jlt.id] = jlt.attachment;
        }
      }

      // Ganti data jelantah recap sepenuhnya (kombinasi dari result.jelantah dan kwitansi tipe Jelantah, filter deleted tombstones)
      const deletedJelantahIds = (pendingDeletes || []).filter(d => d.type === 'jelantah' || d.type === 'kwitansi').map(d => String(d.id).trim());

      let rawJelantah = Array.isArray(result.jelantah) ? [...result.jelantah] : [];
      if (result.kwitansi && Array.isArray(result.kwitansi)) {
        const kwJlt = result.kwitansi.filter(row => {
          const tipe = String(row.Tipe || row.tipeJenis || row['No. Kwitansi'] || row['Tipe Jenis'] || row.guna || row.Keperluan || '').toUpperCase();
          return tipe.includes('JELANTAH');
        });
        rawJelantah = [...rawJelantah, ...kwJlt];
      }

      if (rawJelantah.length > 0) {
        const mapJlt = new Map();
        rawJelantah.forEach(row => {
          const parsed = parseJelantahRow(row);
          if (parsed && parsed.id && !deletedJelantahIds.includes(parsed.id)) {
            if (localJelantahAttachmentMap[parsed.id] && !parsed.attachment) {
              parsed.attachment = localJelantahAttachmentMap[parsed.id];
            }
            mapJlt.set(parsed.id, parsed);
          }
        });
        const parsedJlt = Array.from(mapJlt.values());
        state.jelantahRecap = parsedJlt;
        try {
          await clearStore(STORE_JELANTAH);
          for (const jlt of parsedJlt) {
            await saveToStore(STORE_JELANTAH, jlt);
          }
          localStorage.setItem('jelantah_recap_data', JSON.stringify(state.jelantahRecap));
        } catch (e) { }
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
  } catch (e) { }
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
    else if (id === 'jelantah-section') renderJelantahSection();
  }
}

// ================= RENDER: DASHBOARD =================
function renderDashboard() {
  // 1. Calculate Metrics
  let totalInKas = 0; // Kas masuk dari Pemasukan Kas Utama (Termasuk Sponsor/Sponsorship, APBD, Jelantah, dll; TIDAK termasuk Tenant)
  let totalInTenant = 0; // Pemasukan khusus Rekap Pembayaran Tenant
  let totalOutKas = 0; // Kas keluar dari Kas Resmi (TIDAK termasuk Tenant & Dana Talangan)
  let totalOutAll = 0; // Total pengeluaran keseluruhan
  let txnCount = (state.transactions || []).length;

  (state.transactions || []).forEach(t => {
    const nom = parseInt(t.nominal, 10) || 0;
    const src = String(getTxSumber(t) || '').trim();
    const isTenant = src === 'Pembayaran Tenant' || src === 'Pembayaran Stand';
    const isTalangan = src.includes('Dana Talangan') || src.includes('Tanpa Sumber Dana');

    if (t.tipe === 'IN') {
      if (isTenant) {
        totalInTenant += nom;
      } else {
        totalInKas += nom; // Sponsorship disatukan ke Kas Utama!
      }
    } else if (t.tipe === 'OUT') {
      totalOutAll += nom;
      if (!isTalangan && !isTenant) {
        totalOutKas += nom;
      }
    }
  });

  // Saldo Kas Utama HANYA dihitung dari Kas Pemasukan Utama - Kas Pengeluaran Utama
  let saldoKas = Math.max(0, totalInKas - totalOutKas);

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

  // Total Berat Minyak Jelantah (KG) dari Recap Jelantah
  let totalJelantahKg = 0;
  (state.jelantahRecap || []).forEach(r => {
    totalJelantahKg += parseKgNumber(r.kg || r.nominal);
  });

  // Total Uang Hasil Minyak Jelantah (Rp) dari Pemasukan Transaksi
  let totalJelantahRp = 0;
  (state.transactions || []).forEach(t => {
    const src = String(getTxSumber(t) || '').trim();
    if (t.tipe === 'IN' && src.includes('Minyak Jelantah')) {
      totalJelantahRp += (parseInt(t.nominal, 10) || 0);
    }
  });

  // Total Pemasukan & Pengeluaran Dana APBD
  let totalApbdIn = 0;
  let totalApbdOut = 0;
  (state.transactions || []).forEach(t => {
    const src = String(getTxSumber(t) || '').trim().toUpperCase();
    if (src.includes('APBD')) {
      const nom = parseInt(t.nominal, 10) || 0;
      if (t.tipe === 'IN') totalApbdIn += nom;
      else if (t.tipe === 'OUT') totalApbdOut += nom;
    }
  });
  let sisaApbd = Math.max(0, totalApbdIn - totalApbdOut);

  // Update fields
  if (document.getElementById('dashboard-total-saldo')) document.getElementById('dashboard-total-saldo').textContent = formatRupiah(saldoKas);
  if (document.getElementById('dashboard-total-pemasukan')) document.getElementById('dashboard-total-pemasukan').textContent = formatRupiah(totalInKas);
  if (document.getElementById('dashboard-total-pengeluaran')) document.getElementById('dashboard-total-pengeluaran').textContent = formatRupiah(totalOutKas);
  if (document.getElementById('dashboard-total-tenant')) document.getElementById('dashboard-total-tenant').textContent = formatRupiah(totalInTenant);
  if (document.getElementById('dashboard-total-utang-pending')) document.getElementById('dashboard-total-utang-pending').textContent = formatRupiah(totalUtangPending);
  if (document.getElementById('dashboard-total-talangan-pending')) document.getElementById('dashboard-total-talangan-pending').textContent = formatRupiah(totalTalanganPending);
  if (document.getElementById('dashboard-total-jelantah-kg')) document.getElementById('dashboard-total-jelantah-kg').textContent = `${totalJelantahKg.toLocaleString('id-ID', { maximumFractionDigits: 2 })} KG`;
  if (document.getElementById('dashboard-total-jelantah-rp')) document.getElementById('dashboard-total-jelantah-rp').textContent = formatRupiah(totalJelantahRp);
  if (document.getElementById('dashboard-total-apbd-rp')) document.getElementById('dashboard-total-apbd-rp').textContent = formatRupiah(sisaApbd);
  if (document.getElementById('dashboard-apbd-subtext')) document.getElementById('dashboard-apbd-subtext').textContent = `Masuk: ${formatRupiah(totalApbdIn)} | Keluar: ${formatRupiah(totalApbdOut)}`;

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
    return `${monthNames[parseInt(mm, 10) - 1]} ${y}`;
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
              label: function (context) {
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
  const chronological = [...state.transactions].sort((a, b) => new Date(a.tanggal) - new Date(b.tanggal));
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
    let overallInKas = 0;
    let overallOutKas = 0;
    state.transactions.forEach(t => {
      const src = String(getTxSumber(t) || '').trim();
      const isTenant = src === 'Pembayaran Tenant' || src === 'Pembayaran Stand';
      const isTalangan = src.includes('Dana Talangan') || src.includes('Tanpa Sumber Dana');

      if (t.tipe === 'IN') {
        if (!isTenant) overallInKas += t.nominal; // Sponsorship disatukan ke Kas Utama!
      } else {
        if (!isTalangan && !isTenant) overallOutKas += t.nominal;
      }
    });

    document.getElementById('report-filtered-nominal-sum').textContent = formatRupiah(filteredNominalSum);
    document.getElementById('report-filtered-final-saldo').textContent = formatRupiah(Math.max(0, overallInKas - overallOutKas));
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
      const y = tx.tanggal.slice(0, 4);
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

  return `${d} ${monthNames[parseInt(m, 10) - 1]} ${y}`;
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
    triggeredFrom = 'OUT-FORM';
    customTitle.textContent = 'Tambah Kategori Pengeluaran';
    customLabel.textContent = 'Nama Kategori Baru';
    customInput.value = '';
    customInput.placeholder = 'Misal: Bidang Keamanan';
    customModal.classList.add('open');
  });

  const btnAddSumberAmbilInline = document.getElementById('btn-add-sumber-ambil-inline');
  if (btnAddSumberAmbilInline) {
    btnAddSumberAmbilInline.addEventListener('click', () => {
      inlineAddTargetType = 'SUMBER';
      triggeredFrom = 'AMBIL-FORM';
      customTitle.textContent = 'Tambah Sumber Dana';
      customLabel.textContent = 'Nama Sumber Dana Baru';
      customInput.value = '';
      customInput.placeholder = 'Misal: Sponsorship Eksternal';
      customModal.classList.add('open');
    });
  }

  const btnAddKategoriAmbilInline = document.getElementById('btn-add-kategori-ambil-inline');
  if (btnAddKategoriAmbilInline) {
    btnAddKategoriAmbilInline.addEventListener('click', () => {
      inlineAddTargetType = 'KATEGORI';
      triggeredFrom = 'AMBIL-FORM';
      customTitle.textContent = 'Tambah Bidang Baru';
      customLabel.textContent = 'Nama Bidang Baru';
      customInput.value = '';
      customInput.placeholder = 'Misal: Bidang Keamanan';
      customModal.classList.add('open');
    });
  }

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
      } else if (triggeredFrom === 'AMBIL-FORM') {
        const ambilSumber = document.getElementById('ambil-sumber');
        if (ambilSumber) ambilSumber.value = val;
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
      if (triggeredFrom === 'AMBIL-FORM') {
        const ambilKat = document.getElementById('ambil-kategori');
        if (ambilKat) ambilKat.value = val;
      } else {
        const outKat = document.getElementById('out-kategori');
        if (outKat) outKat.value = val;
      }
    }

    closeInline();
    showToast('Berhasil Ditambahkan', `"${val}" siap digunakan.`, 'success');
  });
}

// Helper to extract Google Drive File ID

function getGoogleDriveFileId(url) {
  if (!url || typeof url !== 'string') return null;
  const match = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/) || 
                url.match(/id=([a-zA-Z0-9_-]+)/) ||
                url.match(/\/d\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : null;
}

// Renders multiple attachments (Google Drive Links or Base64 images)
function renderAttachmentList(renderArea, attachment) {
  if (!renderArea) return;
  renderArea.innerHTML = '';

  let items = [];
  if (Array.isArray(attachment)) {
    items = attachment;
  } else if (typeof attachment === 'string') {
    items = attachment.split(',').map(s => s.trim()).filter(Boolean);
  } else if (typeof attachment === 'object' && attachment !== null) {
    items = [attachment];
  }

  if (items.length === 0) {
    renderArea.innerHTML = '<span class="text-muted" style="font-size: 0.88rem;">Tidak ada bukti transaksi/nota dilampirkan.</span>';
    return;
  }

  const container = document.createElement('div');
  container.className = 'attachment-items-grid';
  container.style.display = 'grid';
  container.style.gridTemplateColumns = 'repeat(auto-fit, minmax(200px, 1fr))';
  container.style.gap = '14px';
  container.style.width = '100%';
  container.style.marginTop = '8px';

  items.forEach((item, idx) => {
    if (!item) return;

    const card = document.createElement('div');
    card.style.display = 'flex';
    card.style.flexDirection = 'column';
    card.style.gap = '8px';
    card.style.padding = '10px';
    card.style.background = '#ffffff';
    card.style.border = '1.5px solid var(--border-color, #e2e8f0)';
    card.style.borderRadius = '12px';
    card.style.boxShadow = '0 2px 8px rgba(0,0,0,0.04)';

    // Case 1: Google Drive URL
    const url = (typeof item === 'string') ? item : (item.url || (item.base64 ? null : ''));
    if (url && (url.startsWith('http://') || url.startsWith('https://'))) {
      const fileId = getGoogleDriveFileId(url);
      const previewUrl = fileId ? `https://lh3.googleusercontent.com/d/${fileId}` : url;
      const fallbackUrl = fileId ? `https://drive.google.com/thumbnail?id=${fileId}&sz=w1000` : url;

      // Photo Box Container
      const photoBox = document.createElement('div');
      photoBox.style.width = '100%';
      photoBox.style.height = '160px';
      photoBox.style.borderRadius = '8px';
      photoBox.style.overflow = 'hidden';
      photoBox.style.background = '#f8fafc';
      photoBox.style.display = 'flex';
      photoBox.style.alignItems = 'center';
      photoBox.style.justifyContent = 'center';
      photoBox.style.cursor = 'pointer';
      photoBox.style.border = '1px solid #e2e8f0';
      photoBox.title = 'Klik untuk memperbesar / membuka foto';

      const img = document.createElement('img');
      img.src = previewUrl;
      img.alt = `Bukti Nota #${idx + 1}`;
      img.style.maxWidth = '100%';
      img.style.maxHeight = '100%';
      img.style.objectFit = 'contain';
      img.style.transition = 'transform 0.2s ease';
      img.onerror = () => {
        if (img.src !== fallbackUrl) {
          img.src = fallbackUrl;
        } else {
          img.style.display = 'none';
          fallbackIcon.style.display = 'flex';
        }
      };

      const fallbackIcon = document.createElement('div');
      fallbackIcon.style.display = 'none';
      fallbackIcon.style.flexDirection = 'column';
      fallbackIcon.style.alignItems = 'center';
      fallbackIcon.style.gap = '4px';
      fallbackIcon.style.color = 'var(--text-muted, #64748b)';
      fallbackIcon.innerHTML = `<span style="font-size: 2.2rem;">📄</span><span style="font-size: 0.78rem; font-weight: 600;">Lihat di Drive</span>`;

      photoBox.appendChild(img);
      photoBox.appendChild(fallbackIcon);
      photoBox.addEventListener('click', () => {
        window.open(url, '_blank');
      });

      // Bottom Action Button: Cek di Google Drive
      const driveBtn = document.createElement('a');
      driveBtn.href = url;
      driveBtn.target = '_blank';
      driveBtn.rel = 'noopener noreferrer';
      driveBtn.className = 'btn btn-secondary btn-small';
      driveBtn.style.display = 'inline-flex';
      driveBtn.style.alignItems = 'center';
      driveBtn.style.justifyContent = 'center';
      driveBtn.style.gap = '6px';
      driveBtn.style.padding = '8px 12px';
      driveBtn.style.textDecoration = 'none';
      driveBtn.style.borderRadius = '8px';
      driveBtn.style.backgroundColor = '#ecfdf5';
      driveBtn.style.color = '#065f46';
      driveBtn.style.border = '1px solid #10b981';
      driveBtn.style.fontWeight = '700';
      driveBtn.style.fontSize = '0.82rem';
      driveBtn.style.width = '100%';
      driveBtn.style.boxSizing = 'border-box';
      driveBtn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
          <polyline points="15 3 21 3 21 9"></polyline>
          <line x1="10" y1="14" x2="21" y2="3"></line>
        </svg>
        <span>Cek Google Drive ${items.length > 1 ? '#' + (idx + 1) : ''}</span>
      `;

      card.appendChild(photoBox);
      card.appendChild(driveBtn);
      container.appendChild(card);
      return;
    }

    // Case 2: Base64 Object { name, type, base64 }
    if (item.base64) {
      if (item.type && item.type.startsWith('image/')) {
        const photoBox = document.createElement('div');
        photoBox.style.width = '100%';
        photoBox.style.height = '160px';
        photoBox.style.borderRadius = '8px';
        photoBox.style.overflow = 'hidden';
        photoBox.style.background = '#f8fafc';
        photoBox.style.display = 'flex';
        photoBox.style.alignItems = 'center';
        photoBox.style.justifyContent = 'center';
        photoBox.style.cursor = 'pointer';
        photoBox.style.border = '1px solid #e2e8f0';
        photoBox.title = 'Klik untuk memperbesar gambar';

        const img = document.createElement('img');
        img.src = item.base64;
        img.alt = item.name || 'Bukti Foto';
        img.style.maxWidth = '100%';
        img.style.maxHeight = '100%';
        img.style.objectFit = 'contain';
        photoBox.appendChild(img);

        photoBox.addEventListener('click', () => {
          const w = window.open();
          w.document.write(`<title>${item.name || 'Bukti Transaksi'}</title><body style="margin:0;background:#111;display:flex;align-items:center;justify-content:center;min-height:100vh;"><img src="${item.base64}" style="max-width:100%;max-height:100vh;object-fit:contain;" /></body>`);
          w.document.close();
        });

        const infoBtn = document.createElement('button');
        infoBtn.type = 'button';
        infoBtn.className = 'btn btn-secondary btn-small';
        infoBtn.style.width = '100%';
        infoBtn.style.fontSize = '0.8rem';
        infoBtn.style.padding = '6px 10px';
        infoBtn.style.fontWeight = '600';
        infoBtn.innerHTML = `🔍 ${item.name ? (item.name.length > 20 ? item.name.substring(0, 17) + '...' : item.name) : 'Lihat Gambar'}`;
        infoBtn.addEventListener('click', () => {
          const w = window.open();
          w.document.write(`<title>${item.name || 'Bukti Transaksi'}</title><body style="margin:0;background:#111;display:flex;align-items:center;justify-content:center;min-height:100vh;"><img src="${item.base64}" style="max-width:100%;max-height:100vh;object-fit:contain;" /></body>`);
          w.document.close();
        });

        card.appendChild(photoBox);
        card.appendChild(infoBtn);
        container.appendChild(card);
      } else {
        const box = document.createElement('div');
        box.className = 'pdf-preview-box';
        box.style.display = 'flex';
        box.style.flexDirection = 'column';
        box.style.alignItems = 'center';
        box.style.justifyContent = 'center';
        box.style.gap = '8px';
        box.style.padding = '16px 12px';
        box.style.height = '160px';
        box.style.boxSizing = 'border-box';
        box.style.backgroundColor = '#f8fafc';
        box.style.borderRadius = '8px';
        box.style.border = '1px solid #e2e8f0';

        box.innerHTML = `<span style="font-size: 2.4rem;">📄</span><span style="font-size: 0.8rem; font-weight: 700; color: var(--text-muted);">${item.name || 'Dokumen PDF'}</span>`;

        const link = document.createElement('button');
        link.type = 'button';
        link.className = 'btn btn-secondary btn-small';
        link.style.width = '100%';
        link.style.fontSize = '0.82rem';
        link.textContent = 'Lihat PDF';
        link.addEventListener('click', () => {
          const pdfWindow = window.open();
          pdfWindow.document.write(`<title>${item.name || 'Dokumen'}</title><iframe width='100%' height='100%' style='border:none;height:100vh;' src='${item.base64}'></iframe>`);
          pdfWindow.document.close();
        });

        card.appendChild(box);
        card.appendChild(link);
        container.appendChild(card);
      }
    }
  });

  if (container.children.length > 0) {
    renderArea.appendChild(container);
  } else {
    renderArea.innerHTML = '<span class="text-muted" style="font-size: 0.88rem;">Tidak ada bukti transaksi/nota dilampirkan.</span>';
  }
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
  renderAttachmentList(renderArea, txn.attachment);

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
        try { await saveToStore(STORE_DELETED_IDS, { id, type: 'transaction', deletedAt: new Date().toISOString() }); } catch (e) { }
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
      csv += `${i + 1};${t.tanggal};${t.id};${t.tipe};${getTxCategory(t)};${getTxSumber(t)};${t.pic};${cleanDesc};${t.nominal};${t.sync ? 'YA' : 'BELUM'}\n`;
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
          <td>${i + 1}</td>
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
  return monthNames[parseInt(mm, 10) - 1] || '';
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

  const togglePwBtn = document.getElementById('toggle-login-password');
  const pwInput = document.getElementById('login-password');
  if (togglePwBtn && pwInput) {
    togglePwBtn.addEventListener('click', () => {
      const currentType = pwInput.getAttribute('type');
      const newType = currentType === 'password' ? 'text' : 'password';
      pwInput.setAttribute('type', newType);
      togglePwBtn.style.color = newType === 'text' ? 'var(--pastel-pink-dark)' : 'var(--text-muted)';
    });
  }

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

function openKwitansiUploadModal(id) {
  const kw = (state.sponsorshipHistory || []).find(k => String(k.id) === String(id));
  if (!kw) {
    showToast('Kwitansi Tidak Ditemukan', 'Data tanda terima tidak ditemukan.', 'error');
    return;
  }
  document.getElementById('kwitansi-upload-id').value = id;
  const title = document.getElementById('kwitansi-upload-title');
  if (title) title.textContent = `Upload Nota / Dokumentasi - No. ${kw.no || kw.id || '-'}`;
  if (fileIndicatorKwitansiUpload) {
    const hasAtt = kw.attachment && (Array.isArray(kw.attachment) ? kw.attachment.length > 0 : true);
    fileIndicatorKwitansiUpload.innerHTML = hasAtt
      ? '<span style="color:var(--success, #10b981);font-weight:bold;">✓ Tanda terima ini sudah memiliki lampiran (mengunggah berkas baru akan menggantikan lampiran lama).</span>'
      : '';
  }
  state.currentUpload = null;
  const fileInput = document.getElementById('kwitansi-upload-file');
  if (fileInput) fileInput.value = '';

  document.getElementById('kwitansi-upload-modal').classList.add('open');
}

function closeKwitansiUploadModal() {
  document.getElementById('kwitansi-upload-modal').classList.remove('open');
}

function setupSponsorshipHandlers() {
  if (isSponsorshipSetupDone) return;

  // Setup Kwitansi Upload Modal Event Listeners
  const btnCloseKwUpload = document.getElementById('btn-close-kwitansi-upload');
  if (btnCloseKwUpload) btnCloseKwUpload.addEventListener('click', closeKwitansiUploadModal);

  const btnCancelKwUpload = document.getElementById('btn-cancel-kwitansi-upload');
  if (btnCancelKwUpload) btnCancelKwUpload.addEventListener('click', closeKwitansiUploadModal);

  const btnSubmitKwUpload = document.getElementById('btn-submit-kwitansi-upload');
  if (btnSubmitKwUpload) {
    btnSubmitKwUpload.addEventListener('click', async () => {
      const id = document.getElementById('kwitansi-upload-id').value;
      if (!id) return;

      if (!state.currentUpload || state.currentUpload.length === 0) {
        showToast('Berkas Kosong', 'Pilih minimal satu berkas foto/nota untuk diupload.', 'error');
        return;
      }

      const kwIdx = (state.sponsorshipHistory || []).findIndex(k => String(k.id) === String(id));
      if (kwIdx !== -1) {
        state.sponsorshipHistory[kwIdx].attachment = state.currentUpload;
        try { await saveToStore(STORE_SPONSORSHIPS, state.sponsorshipHistory[kwIdx]); } catch (e) { }
        try { localStorage.setItem('sponsorship_history', JSON.stringify(state.sponsorshipHistory)); } catch (e) { }

        // Juga update di catatan jelantah jika cocok
        if (state.jelantahRecap) {
          const jIdx = state.jelantahRecap.findIndex(j => String(j.id) === String(id));
          if (jIdx !== -1) {
            state.jelantahRecap[jIdx].attachment = state.currentUpload;
            try { await saveToStore(STORE_JELANTAH, state.jelantahRecap[jIdx]); } catch (e) { }
            try { localStorage.setItem('jelantah_recap_data', JSON.stringify(state.jelantahRecap)); } catch (e) { }
          }
        }

        showToast('Berhasil', 'Nota/Dokumentasi tersimpan. Sedang mengunggah ke Google Drive & Sheets...', 'success');
        closeKwitansiUploadModal();

        renderSponsorshipHistoryTable();
        renderJelantahSection();

        // Trigger sync ke Google Drive & Sheets
        await syncKwitansiToSheets(state.sponsorshipHistory[kwIdx]);
      }
    });
  }

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

      csv += `${i + 1};No. ${item.no || '001'};${tipeText};${item.tgl || '-'};${cleanDari};${formattedNominal};${cleanTerbilang};${cleanGuna};${item.penerima || '-'};${item.nta || '-'}\n`;
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
          <td style="text-align:center;">${i + 1}</td>
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

    const hasAtt = item.attachment && (Array.isArray(item.attachment) ? item.attachment.length > 0 : true);
    const attachBtn = hasAtt
      ? `<button type="button" class="btn btn-small btn-success btn-icon-small" onclick="openKwitansiUploadModal('${item.id}')" title="Lihat / Ganti Nota atau Bukti Terlampir">✓ Terlampir</button>`
      : `<button type="button" class="btn btn-small btn-secondary btn-icon-small" onclick="openKwitansiUploadModal('${item.id}')" title="Upload Nota / Dokumentasi">📎 Upload</button>`;

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
            ${attachBtn}
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
  const isJelantah = item && (item.tipeJenis === 'JELANTAH' || (item.guna && item.guna.toUpperCase().includes('JELANTAH')));

  try {
    await deleteFromStore(STORE_SPONSORSHIPS, id);
  } catch (e) { }

  state.sponsorshipHistory = state.sponsorshipHistory.filter(h => h.id !== id);
  try {
    localStorage.setItem('sponsorship_history', JSON.stringify(state.sponsorshipHistory));
  } catch (e) { }

  if (isJelantah) {
    state.jelantahRecap = (state.jelantahRecap || []).filter(r => r.id !== id);
    try { await deleteFromStore(STORE_JELANTAH, id); } catch (e) { }
    try { localStorage.setItem('jelantah_recap_data', JSON.stringify(state.jelantahRecap)); } catch (e) { }
    try { await saveToStore(STORE_DELETED_IDS, { id, type: 'jelantah', deletedAt: new Date().toISOString() }); } catch (e) { }
    renderJelantahSection();
    renderDashboard();
  }

  if (state.settings.sheetUrl) {
    syncKwitansiToSheets_delete(id, kwNo);
  }

  renderSponsorshipHistoryTable();
  showToast('Riwayat Dihapus', 'Item kwitansi berhasil dihapus dari riwayat.', 'info');
}

async function syncKwitansiToSheets_delete(id, no) {
  if (!state.settings.sheetUrl) {
    // Simpan ke tombstone jika tidak ada URL
    try { await saveToStore(STORE_DELETED_IDS, { id, type: 'kwitansi', no: no || '', deletedAt: new Date().toISOString() }); } catch (e) { }
    return;
  }
  // Simpan ke tombstone dulu sebelum coba kirim
  try { await saveToStore(STORE_DELETED_IDS, { id, type: 'kwitansi', no: no || '', deletedAt: new Date().toISOString() }); } catch (e) { }
  try {
    await fetch(state.settings.sheetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ action: 'delete_kwitansi', id: id, no: no })
    });
    // Berhasil → hapus dari tombstone
    try { await deleteFromStore(STORE_DELETED_IDS, id); } catch (e) { }
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
    } catch (e) { }

    state.sponsorshipHistory.unshift(historyItem);
    try {
      localStorage.setItem('sponsorship_history', JSON.stringify(state.sponsorshipHistory));
    } catch (e) { }

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
    const cleanKw = {
      id: kw.id,
      tipeJenis: kw.tipeJenis || 'SPONSORSHIP',
      no: kw.no || kw.id,
      tgl: kw.tgl || kw.tanggal || '',
      dari: kw.dari || '',
      nominal: kw.nominal,
      terbilang: kw.terbilang || '',
      guna: kw.guna || '',
      penerima: kw.penerima || '',
      nta: kw.nta || '',
      attachment: kw.attachment || null,
      dateCreated: kw.dateCreated || new Date().toISOString()
    };

    await fetch(state.settings.sheetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ action: 'sync_kwitansi', kwitansi: cleanKw })
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
      } catch (e) { }

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

      csv += `${i + 1};${u.id};${u.tanggal};${tipeText};${cleanNama};${cleanSumber};${u.nominal};${cleanKeterangan};${statusText};${u.tanggalLunas || '-'}\n`;
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
          <td style="text-align:center;">${i + 1}</td>
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
    try { await saveToStore(STORE_UTANG, item); } catch (e) { }
    try { localStorage.setItem('raimuna_utang_data', JSON.stringify(state.utang)); } catch (e) { }
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

    try { await saveToStore(STORE_UTANG, item); } catch (e) { }
    try { localStorage.setItem('raimuna_utang_data', JSON.stringify(state.utang)); } catch (e) { }
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
      await syncDeleteToSheets(txIdToDelete);
    } else {
      try { await saveToStore(STORE_DELETED_IDS, { id: txIdToDelete, type: 'transaction', deletedAt: new Date().toISOString() }); } catch (e) { }
    }
  }

  // Hapus dari state memori dan DB lokal
  state.utang = state.utang.filter(u => u.id !== utangId);
  try { await deleteFromStore(STORE_UTANG, utangId); } catch (e) { }
  try { localStorage.setItem('raimuna_utang_data', JSON.stringify(state.utang)); } catch (e) { }

  // Selalu catat ke tombstone DULU agar tidak balik saat autoPull, lalu kirim hapus ke Google Sheets
  if (state.settings.sheetUrl) {
    await syncUtangToSheets_delete(utangId);
  } else {
    try { await saveToStore(STORE_DELETED_IDS, { id: utangId, type: 'utang', deletedAt: new Date().toISOString() }); } catch (e) { }
  }

  showToast('Catatan Utang Dihapus', 'Data utang berhasil dihapus.', 'info');
  renderUtangPage();
  renderDashboard();
}

async function syncUtangToSheets(ut) {
  if (!state.settings.sheetUrl) return;
  try {
    await fetch(state.settings.sheetUrl, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ action: 'sync_utang', utang: ut })
    });
  } catch (err) {
    console.error('Failed to sync utang to sheet:', err);
  }
}

async function syncUtangToSheets_delete(utangId) {
  try { await saveToStore(STORE_DELETED_IDS, { id: utangId, type: 'utang', deletedAt: new Date().toISOString() }); } catch (e) { }
  if (!state.settings.sheetUrl) return;

  try {
    await fetch(state.settings.sheetUrl, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ action: 'delete_utang', id: utangId })
    });
    setTimeout(async () => {
      try { await deleteFromStore(STORE_DELETED_IDS, utangId); } catch (e) { }
    }, 1500);
  } catch (err) {
    console.error('Gagal hapus utang dari Sheet, akan dicoba ulang saat startup:', err);
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

// ================= RECAP JELANTAH MODULE =================
let jelantahDokFiles = [];
let jelantahNotaFiles = [];
let jelantahEditDokFiles = [];
let jelantahEditNotaFiles = [];

let jelantahAddDokDropzone = null;
let jelantahAddNotaDropzone = null;
let jelantahEditDokDropzone = null;
let jelantahEditNotaDropzone = null;

function setupJelantahHandlers() {
  const formJelantah = document.getElementById('form-jelantah-add');
  if (!formJelantah) return;

  const today = new Date().toISOString().split('T')[0];
  if (document.getElementById('jelantah-tanggal')) {
    document.getElementById('jelantah-tanggal').value = today;
  }

  // Setup Dropzones for Jelantah (Add form)
  const dropDok = document.getElementById('jelantah-dok-dropzone');
  const indDok = document.getElementById('jelantah-dok-indicator');
  const inputDok = document.getElementById('jelantah-bukti-dok');

  const dropNota = document.getElementById('jelantah-nota-dropzone');
  const indNota = document.getElementById('jelantah-nota-indicator');
  const inputNota = document.getElementById('jelantah-bukti-nota');

  // Setup Dropzones for Jelantah (Edit form)
  const dropEditDok = document.getElementById('edit-jelantah-dok-dropzone');
  const indEditDok = document.getElementById('edit-jelantah-dok-indicator');
  const inputEditDok = document.getElementById('edit-jelantah-bukti-dok');

  const dropEditNota = document.getElementById('edit-jelantah-nota-dropzone');
  const indEditNota = document.getElementById('edit-jelantah-nota-indicator');
  const inputEditNota = document.getElementById('edit-jelantah-bukti-nota');

  if (dropDok && inputDok) {
    jelantahAddDokDropzone = setupCustomMultiFileDropzone(dropDok, inputDok, indDok, (files) => {
      jelantahDokFiles = files;
    });
  }

  if (dropNota && inputNota) {
    jelantahAddNotaDropzone = setupCustomMultiFileDropzone(dropNota, inputNota, indNota, (files) => {
      jelantahNotaFiles = files;
    });
  }

  if (dropEditDok && inputEditDok) {
    jelantahEditDokDropzone = setupCustomMultiFileDropzone(dropEditDok, inputEditDok, indEditDok, (files) => {
      jelantahEditDokFiles = files;
    });
  }

  if (dropEditNota && inputEditNota) {
    jelantahEditNotaDropzone = setupCustomMultiFileDropzone(dropEditNota, inputEditNota, indEditNota, (files) => {
      jelantahEditNotaFiles = files;
    });
  }

  // Form submit listener (Add Jelantah)
  formJelantah.addEventListener('submit', async (e) => {
    e.preventDefault();

    const tgl = document.getElementById('jelantah-tanggal').value;
    const kwarran = document.getElementById('jelantah-kwarran').value;
    const kgStr = document.getElementById('jelantah-kg').value.replace(',', '.');
    const kg = parseFloat(kgStr) || 0;
    const ket = document.getElementById('jelantah-keterangan').value;

    if (!kwarran) {
      showToast('Pilih Kwarran', 'Silakan pilih nama kwarran terlebih dahulu.', 'error');
      return;
    }
    if (kg <= 0) {
      showToast('Jumlah Tidak Valid', 'Jumlah minyak jelantah (KG) harus lebih dari 0.', 'error');
      return;
    }

    const allAttachments = [...(jelantahDokFiles || []), ...(jelantahNotaFiles || [])];

    const newRecord = {
      id: generateUniqueId('JLT'),
      tanggal: tgl,
      tgl: tgl,
      kwarran: kwarran,
      dari: kwarran,
      kg: kg,
      nominal: `${kg} KG`,
      terbilang: `${terbilangKg(kg)} KILOGRAM`,
      keterangan: ket,
      guna: ket ? `PENGAMBILAN MINYAK JELANTAH (${ket})` : 'PENGAMBILAN MINYAK JELANTAH',
      penerima: state.user ? (state.user.nama || 'Tri Soma Ananta Rahman') : 'Tri Soma Ananta Rahman',
      nta: 'Ketua Panitia',
      attachment: allAttachments.length > 0 ? allAttachments : null,
      dateCreated: new Date().toISOString()
    };

    if (!state.jelantahRecap) state.jelantahRecap = [];
    state.jelantahRecap.unshift(newRecord);

    try { await saveToStore(STORE_JELANTAH, newRecord); } catch (err) { }
    try { localStorage.setItem('jelantah_recap_data', JSON.stringify(state.jelantahRecap)); } catch (err) { }

    // Synchronize to sponsorshipHistory / Kwitansi list as well
    const kwEntry = {
      id: newRecord.id,
      tipeJenis: 'JELANTAH',
      no: newRecord.id,
      tgl: newRecord.tgl,
      dari: newRecord.kwarran,
      nominal: newRecord.nominal,
      terbilang: newRecord.terbilang,
      guna: newRecord.guna,
      penerima: newRecord.penerima,
      nta: 'Ketua Panitia',
      attachment: newRecord.attachment,
      dateCreated: newRecord.dateCreated
    };
    if (!state.sponsorshipHistory) state.sponsorshipHistory = [];
    state.sponsorshipHistory.unshift(kwEntry);
    try { await saveToStore(STORE_SPONSORSHIPS, kwEntry); } catch (err) { }
    try { localStorage.setItem('sponsorship_history', JSON.stringify(state.sponsorshipHistory)); } catch (err) { }

    if (state.settings.sheetUrl) {
      syncJelantahToSheets(newRecord);
    }

    showToast('Recap Jelantah Disimpan!', `Data pengambilan ${kg} KG dari ${kwarran} berhasil dicatat.`, 'success');

    // Reset Form
    formJelantah.reset();
    document.getElementById('jelantah-tanggal').value = today;
    if (jelantahAddDokDropzone) jelantahAddDokDropzone.reset();
    if (jelantahAddNotaDropzone) jelantahAddNotaDropzone.reset();
    jelantahDokFiles = [];
    jelantahNotaFiles = [];

    renderJelantahSection();
    renderSponsorshipHistoryTable();
    renderDashboard();
  });

  // Edit form submit listener
  const formEditJelantah = document.getElementById('form-jelantah-edit');
  if (formEditJelantah) {
    formEditJelantah.addEventListener('submit', async (e) => {
      e.preventDefault();
      const id = document.getElementById('edit-jelantah-id').value;
      const tgl = document.getElementById('edit-jelantah-tanggal').value;
      const kwarran = document.getElementById('edit-jelantah-kwarran').value;
      const kgStr = document.getElementById('edit-jelantah-kg').value.replace(',', '.');
      const kg = parseFloat(kgStr) || 0;
      const ket = document.getElementById('edit-jelantah-keterangan').value;

      const rec = (state.jelantahRecap || []).find(item => String(item.id) === String(id));
      if (rec) {
        rec.tgl = tgl;
        rec.tanggal = tgl;
        rec.kwarran = kwarran;
        rec.dari = kwarran;
        rec.kg = kg;
        rec.nominal = `${kg} KG`;
        rec.terbilang = `${terbilangKg(kg)} KILOGRAM`;
        rec.keterangan = ket;
        rec.guna = ket ? `PENGAMBILAN MINYAK JELANTAH (${ket})` : 'PENGAMBILAN MINYAK JELANTAH';

        const newEditUploads = [...(jelantahEditDokFiles || []), ...(jelantahEditNotaFiles || [])];
        if (newEditUploads.length > 0) {
          rec.attachment = newEditUploads;
        }

        try { await saveToStore(STORE_JELANTAH, rec); } catch (err) { }
        try { localStorage.setItem('jelantah_recap_data', JSON.stringify(state.jelantahRecap)); } catch (err) { }

        // Also update matching item in sponsorshipHistory
        const kwItem = (state.sponsorshipHistory || []).find(h => String(h.id) === String(id));
        if (kwItem) {
          kwItem.tgl = tgl;
          kwItem.dari = kwarran;
          kwItem.nominal = `${kg} KG`;
          kwItem.terbilang = `${terbilangKg(kg)} KILOGRAM`;
          kwItem.guna = rec.guna;
          if (newEditUploads.length > 0) {
            kwItem.attachment = newEditUploads;
          }
          try { await saveToStore(STORE_SPONSORSHIPS, kwItem); } catch (err) { }
          try { localStorage.setItem('sponsorship_history', JSON.stringify(state.sponsorshipHistory)); } catch (err) { }
        }

        if (state.settings.sheetUrl) {
          syncJelantahToSheets(rec);
        }

        showToast('Perubahan Disimpan!', `Data ${kwarran} (${kg} KG) berhasil diperbarui.`, 'success');
        const modalEdit = document.getElementById('modal-edit-jelantah');
        if (modalEdit) {
          modalEdit.classList.remove('open');
          modalEdit.classList.remove('active');
        }
        if (jelantahEditDokDropzone) jelantahEditDokDropzone.reset();
        if (jelantahEditNotaDropzone) jelantahEditNotaDropzone.reset();
        jelantahEditDokFiles = [];
        jelantahEditNotaFiles = [];
        renderJelantahSection();
        renderSponsorshipHistoryTable();
        renderDashboard();
      }
    });
  }

  // Search filter
  const searchInput = document.getElementById('filter-jelantah-search');
  if (searchInput) {
    searchInput.addEventListener('input', () => renderJelantahSection());
  }

  // Exports
  const btnExcel = document.getElementById('btn-export-jelantah-excel');
  if (btnExcel) btnExcel.addEventListener('click', exportJelantahExcel);

  const btnCsv = document.getElementById('btn-export-jelantah-csv');
  if (btnCsv) btnCsv.addEventListener('click', exportJelantahCSV);
}

function setupCustomMultiFileDropzone(dropzone, fileInput, indicator, onFilesReady) {
  if (!dropzone || !fileInput) return null;
  let fileList = [];

  function updateIndicator() {
    if (!indicator) return;
    if (fileList.length > 0) {
      indicator.innerHTML = `
        <div style="margin-top: 8px; display: flex; flex-direction: column; gap: 4px; align-items: center; width: 100%;">
          <div style="font-weight: 700; color: var(--success, #10b981); font-size: 0.83rem;">
            ✓ ${fileList.length} berkas siap diunggah
          </div>
          <div style="display: flex; flex-wrap: wrap; gap: 4px; justify-content: center; max-width: 100%;">
            ${fileList.map((u, i) => `
              <span style="display: inline-flex; align-items: center; gap: 4px; background: #e0f2fe; color: #0369a1; border: 1px solid #bae6fd; padding: 3px 8px; border-radius: 6px; font-size: 0.75rem; font-weight: 600;">
                📎 ${u.name && u.name.length > 15 ? u.name.substring(0, 12) + '...' : (u.name || 'Berkas ' + (i + 1))}
                <button type="button" class="btn-remove-drop-file" data-idx="${i}" style="background: none; border: none; color: #ef4444; font-weight: bold; cursor: pointer; padding: 0 2px; font-size: 0.9rem;" title="Hapus berkas ini">&times;</button>
              </span>
            `).join('')}
          </div>
          <div style="font-size: 0.72rem; color: #6366f1; margin-top: 2px;">
            + Klik / seret lagi untuk menambah
          </div>
        </div>
      `;
      indicator.querySelectorAll('.btn-remove-drop-file').forEach(btn => {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          e.preventDefault();
          const idx = parseInt(btn.dataset.idx, 10);
          fileList.splice(idx, 1);
          updateIndicator();
          if (typeof onFilesReady === 'function') onFilesReady(fileList);
        });
      });
    } else {
      indicator.innerHTML = '';
    }
  }

  async function handleFiles(files) {
    if (!files || files.length === 0) return;
    const filesArray = Array.from(files);
    if (indicator) indicator.innerHTML = `<span style="color: var(--text-muted); font-size: 0.82rem;">Memproses & mengoptimalkan ${filesArray.length} berkas...</span>`;

    for (const file of filesArray) {
      try {
        const item = await compressImageFile(file);
        if (item && item.base64) {
          if (!fileList.some(ex => ex.name === item.name && ex.base64 === item.base64)) {
            fileList.push(item);
          }
        }
      } catch (err) {
        console.warn('Gagal memproses file:', file.name, err);
      }
    }
    updateIndicator();
    if (typeof onFilesReady === 'function') onFilesReady(fileList);
  }

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
    if (e.dataTransfer.files && e.dataTransfer.files.length) {
      handleFiles(e.dataTransfer.files);
    }
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files && fileInput.files.length) {
      handleFiles(fileInput.files);
    }
  });

  return {
    reset: () => {
      fileList = [];
      updateIndicator();
      if (typeof onFilesReady === 'function') onFilesReady([]);
    },
    setFiles: (files) => {
      fileList = Array.isArray(files) ? [...files] : [];
      updateIndicator();
      if (typeof onFilesReady === 'function') onFilesReady(fileList);
    },
    getFiles: () => fileList
  };
}

function terbilangKg(n) {
  if (isNaN(n) || n === null || n === undefined) return '';
  n = Math.floor(n);
  if (n === 0) return 'NOL';
  const satuan = ['', 'SATU', 'DUA', 'TIGA', 'EMPAT', 'LIMA', 'ENAM', 'TUJUH', 'DELAPAN', 'SEMBILAN', 'SEPULUH', 'SEBELAS'];
  if (n < 12) return satuan[n];
  if (n < 20) return terbilangKg(n - 10) + ' BELAS';
  if (n < 100) return (terbilangKg(Math.floor(n / 10)) + ' PULUH ' + terbilangKg(n % 10)).trim();
  if (n < 200) return ('SERATUS ' + terbilangKg(n - 100)).trim();
  if (n < 1000) return (terbilangKg(Math.floor(n / 100)) + ' RATUS ' + terbilangKg(n % 100)).trim();
  if (n < 2000) return ('SERIBU ' + terbilangKg(n - 1000)).trim();
  if (n < 1000000) return (terbilangKg(Math.floor(n / 1000)) + ' RIBU ' + terbilangKg(n % 1000)).trim();
  return String(n);
}

function parseKgNumber(val) {
  if (typeof val === 'number') return val;
  if (!val) return 0;
  let str = String(val).replace(/[^0-9.,]/g, '').replace(',', '.');
  return parseFloat(str) || 0;
}

function getJelantahRecords() {
  return state.jelantahRecap || [];
}

function renderJelantahSection() {
  const records = getJelantahRecords();

  // 1. Calculate Metrics
  let totalKg = 0;
  const kwarrans = new Set();

  records.forEach(r => {
    const kg = parseKgNumber(r.kg || r.nominal);
    totalKg += kg;
    if (r.dari || r.kwarran) kwarrans.add((r.dari || r.kwarran).trim());
  });

  if (document.getElementById('jelantah-metric-kg')) document.getElementById('jelantah-metric-kg').textContent = `${totalKg.toLocaleString('id-ID', { maximumFractionDigits: 2 })} KG`;
  if (document.getElementById('jelantah-metric-kwarran')) document.getElementById('jelantah-metric-kwarran').textContent = `${kwarrans.size} Kwarran`;
  if (document.getElementById('jelantah-metric-count')) document.getElementById('jelantah-metric-count').textContent = `${records.length} Catatan`;

  // 2. Render Chart Jelantah
  renderJelantahChart(records);

  // 3. Render Table Jelantah
  const tbody = document.getElementById('table-jelantah-tbody');
  if (!tbody) return;
  tbody.innerHTML = '';

  const search = String(document.getElementById('filter-jelantah-search')?.value || '').toLowerCase().trim();

  const filtered = records.filter(r => {
    if (!search) return true;
    const matchDari = String(r.dari || r.kwarran || '').toLowerCase().includes(search);
    const matchGuna = String(r.guna || r.keterangan || '').toLowerCase().includes(search);
    const matchTgl = String(r.tgl || r.tanggal || '').toLowerCase().includes(search);
    const matchNom = String(r.nominal || r.kg || '').toLowerCase().includes(search);
    return matchDari || matchGuna || matchTgl || matchNom;
  });

  if (filtered.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="text-center text-muted" style="padding: 24px;">Tidak ada data pengambilan jelantah yang cocok.</td></tr>';
    return;
  }

  filtered.forEach((r, idx) => {
    const tr = document.createElement('tr');
    tr.style.cursor = 'pointer';
    tr.title = 'Klik baris untuk membuka detail & menu aksi';
    tr.addEventListener('click', () => {
      showJelantahDetailModal(r);
    });

    let kgVal = r.nominal || `${r.kg || 0} KG`;
    if (typeof kgVal === 'number' || (typeof kgVal === 'string' && !kgVal.toUpperCase().includes('KG'))) {
      kgVal = `${kgVal} KG`;
    }

    // Attachments preview links
    let attHtml = '<span class="text-muted" style="font-size:0.85rem;">Tidak ada berkas</span>';
    if (r.attachment) {
      const atts = Array.isArray(r.attachment) ? r.attachment : [r.attachment];
      if (atts.length > 0) {
        attHtml = atts.map((att, i) => {
          const isUrl = typeof att === 'string' && att.startsWith('http');
          const href = isUrl ? att : (att.base64 || '#');
          const name = isUrl ? `Berkas ${i + 1}` : (att.name || `Berkas ${i + 1}`);
          return `<a href="${href}" target="_blank" class="badge-tag info" style="display:inline-block; margin:2px; padding:3px 8px; text-decoration:none;" onclick="event.stopPropagation()">📎 ${name}</a>`;
        }).join('');
      }
    }

    tr.innerHTML = `
      <td>${idx + 1}</td>
      <td>${formatIndonesianDate(r.tgl || r.tanggal)}</td>
      <td class="font-bold">${r.dari || r.kwarran || '-'}</td>
      <td class="text-right font-bold text-success" style="font-size:1.05rem;">${kgVal}</td>
      <td>${attHtml}</td>
      <td>${r.guna || r.keterangan || '-'}</td>
      <td class="text-center" style="white-space: nowrap;">
        <button class="btn-icon btn-edit-jelantah" data-id="${r.id}" title="Edit Recap Jelantah" style="margin-right: 6px;">✏️</button>
        <button class="btn-icon btn-view-jelantah" data-id="${r.id}" title="Lihat Detail Pengambilan Jelantah" style="margin-right: 6px;">👁️</button>
        <button class="btn-icon btn-delete-jelantah" data-id="${r.id}" title="Hapus Recap Jelantah">🗑️</button>
      </td>
    `;

    const btnEdit = tr.querySelector('.btn-edit-jelantah');
    if (btnEdit) {
      btnEdit.addEventListener('click', (e) => {
        e.stopPropagation();
        openEditJelantahModal(r);
      });
    }

    const btnView = tr.querySelector('.btn-view-jelantah');
    if (btnView) {
      btnView.addEventListener('click', (e) => {
        e.stopPropagation();
        showJelantahDetailModal(r);
      });
    }

    const btnDel = tr.querySelector('.btn-delete-jelantah');
    if (btnDel) {
      btnDel.addEventListener('click', (e) => {
        e.stopPropagation();
        deleteJelantahRecord(r.id);
      });
    }

    tbody.appendChild(tr);
  });
}

function showJelantahDetailModal(r) {
  const modal = document.getElementById('modal-detail-jelantah');
  const body = document.getElementById('jelantah-detail-body');
  if (!modal || !body) return;

  let kgVal = r.nominal || r.kg;
  if (typeof kgVal === 'number' || (typeof kgVal === 'string' && !kgVal.toUpperCase().includes('KG'))) {
    kgVal = `${kgVal} KG`;
  }

  // Attachments html
  let attHtml = '<p class="text-muted" style="font-size:0.85rem;">Tidak ada berkas dokumentasi / nota.</p>';
  if (r.attachment) {
    const atts = Array.isArray(r.attachment) ? r.attachment : [r.attachment];
    if (atts.length > 0) {
      attHtml = '<div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-top: 10px;">';
      atts.forEach((att, i) => {
        const isUrl = typeof att === 'string' && (att.startsWith('http://') || att.startsWith('https://'));
        const src = isUrl ? att : (att.base64 || '');
        const name = isUrl ? `Dokumentasi #${i + 1}` : (att.name || `Dokumentasi #${i + 1}`);

        if (isUrl) {
          const fileId = getGoogleDriveFileId(src);
          const previewUrl = fileId ? `https://lh3.googleusercontent.com/d/${fileId}` : src;
          const fallbackUrl = fileId ? `https://drive.google.com/thumbnail?id=${fileId}&sz=w1000` : src;

          attHtml += `
            <div style="background: #ffffff; border: 1.5px solid var(--border-color, #e2e8f0); border-radius: 10px; padding: 8px; display: flex; flex-direction: column; gap: 8px; box-shadow: 0 2px 6px rgba(0,0,0,0.04);">
              <div style="width: 100%; height: 140px; border-radius: 6px; overflow: hidden; background: #f8fafc; display: flex; align-items: center; justify-content: center; cursor: pointer; border: 1px solid #e2e8f0;" onclick="window.open('${src}', '_blank')">
                <img src="${previewUrl}" onerror="if(this.src!=='${fallbackUrl}'){this.src='${fallbackUrl}';}else{this.style.display='none';this.nextElementSibling.style.display='flex';}" alt="${name}" style="max-width: 100%; max-height: 100%; object-fit: contain;" />
                <div style="display: none; flex-direction: column; align-items: center; gap: 4px; color: var(--text-muted);">
                  <span style="font-size: 2rem;">📄</span>
                  <span style="font-size: 0.75rem; font-weight: 600;">Lihat di Drive</span>
                </div>
              </div>
              <a href="${src}" target="_blank" rel="noopener noreferrer" class="btn btn-secondary btn-small" style="padding: 7px 10px; font-size: 0.8rem; text-decoration: none; display: inline-flex; align-items: center; justify-content: center; gap: 6px; background-color: #ecfdf5; color: #065f46; border: 1px solid #10b981; border-radius: 6px; font-weight: 700;">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
                <span>Cek Google Drive ${atts.length > 1 ? '#' + (i + 1) : ''}</span>
              </a>
            </div>
          `;
        } else if (src) {
          attHtml += `
            <div style="background: #ffffff; border: 1.5px solid var(--border-color, #e2e8f0); border-radius: 10px; padding: 8px; display: flex; flex-direction: column; gap: 8px; box-shadow: 0 2px 6px rgba(0,0,0,0.04);">
              <div style="width: 100%; height: 140px; border-radius: 6px; overflow: hidden; background: #f8fafc; display: flex; align-items: center; justify-content: center; cursor: pointer; border: 1px solid #e2e8f0;" onclick="window.open('${src}', '_blank')">
                <img src="${src}" alt="${name}" style="max-width: 100%; max-height: 100%; object-fit: contain;" />
              </div>
              <button type="button" class="btn btn-secondary btn-small" style="padding: 6px 10px; font-size: 0.8rem; font-weight: 600; width: 100%;" onclick="window.open('${src}', '_blank')">
                🔍 ${name}
              </button>
            </div>
          `;
        }
      });
      attHtml += '</div>';
    }
  }

  body.innerHTML = `
    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 16px;">
      <div style="background: var(--bg-body, #f9fafb); padding: 12px; border-radius: 8px; border: 1px solid var(--border-color);">
        <span style="font-size: 0.75rem; color: var(--text-muted); display: block; font-weight: 600;">ID CATATAN</span>
        <strong style="font-size: 0.95rem;">${r.id}</strong>
      </div>
      <div style="background: var(--bg-body, #f9fafb); padding: 12px; border-radius: 8px; border: 1px solid var(--border-color);">
        <span style="font-size: 0.75rem; color: var(--text-muted); display: block; font-weight: 600;">TANGGAL PENGAMBILAN</span>
        <strong style="font-size: 0.95rem;">${formatIndonesianDate(r.tgl || r.tanggal)}</strong>
      </div>
      <div style="background: var(--bg-body, #f9fafb); padding: 12px; border-radius: 8px; border: 1px solid var(--border-color); grid-column: span 2;">
        <span style="font-size: 0.75rem; color: var(--text-muted); display: block; font-weight: 600;">NAMA KWARRAN</span>
        <strong style="font-size: 1.1rem; color: var(--color-primary, #2563eb);">${r.kwarran || r.dari || '-'}</strong>
      </div>
      <div style="background: #ecfdf5; padding: 12px; border-radius: 8px; border-left: 4px solid #10b981; grid-column: span 2;">
        <span style="font-size: 0.75rem; color: #047857; display: block; font-weight: 600;">JUMLAH MINYAK JELANTAH</span>
        <strong style="font-size: 1.25rem; color: #065f46;">${kgVal}</strong>
        <span style="font-size: 0.8rem; color: #047857; display: block; margin-top: 2px; font-weight: 600;">(${r.terbilang || (terbilangKg(parseKgNumber(r.kg || r.nominal)) + ' KILOGRAM')})</span>
      </div>
      <div style="background: var(--bg-body, #f9fafb); padding: 12px; border-radius: 8px; border: 1px solid var(--border-color); grid-column: span 2;">
        <span style="font-size: 0.75rem; color: var(--text-muted); display: block; font-weight: 600;">KETERANGAN / DESKRIPSI</span>
        <p style="margin-top: 4px; font-size: 0.9rem; margin-bottom: 0;">${r.keterangan || r.guna || '-'}</p>
      </div>
    </div>
    <div style="border-top: 1px solid var(--border-color); padding-top: 12px;">
      <h4 style="font-size: 0.88rem; font-weight: 600; margin-bottom: 6px;">📸 Dokumentasi & Lampiran Nota:</h4>
      ${attHtml}
    </div>
  `;

  modal.classList.add('open');
  modal.classList.add('active');

  const closeModal = () => {
    modal.classList.remove('open');
    modal.classList.remove('active');
  };
  const btnCloseHeader = document.getElementById('btn-close-jelantah-detail');
  const btnCloseFooter = document.getElementById('btn-close-jelantah-detail-footer');
  const btnDelete = document.getElementById('btn-delete-jelantah-detail');
  const btnEdit = document.getElementById('btn-edit-jelantah-detail');

  if (btnCloseHeader) btnCloseHeader.onclick = closeModal;
  if (btnCloseFooter) btnCloseFooter.onclick = closeModal;

  if (btnDelete) {
    btnDelete.onclick = () => {
      closeModal();
      deleteJelantahRecord(r.id);
    };
  }

  if (btnEdit) {
    btnEdit.onclick = () => {
      closeModal();
      openEditJelantahModal(r);
    };
  }
}

function renderJelantahChart(records) {
  const canvas = document.getElementById('jelantahChart');
  if (!canvas) return;

  const kwarranMap = {};
  records.forEach(r => {
    const kwName = (r.dari || r.kwarran || 'Lainnya').trim();
    const kg = parseKgNumber(r.kg || r.nominal);
    kwarranMap[kwName] = (kwarranMap[kwName] || 0) + kg;
  });

  const labels = Object.keys(kwarranMap);
  const dataValues = Object.values(kwarranMap);

  if (window.jelantahChartInstance) {
    window.jelantahChartInstance.destroy();
  }

  const ctx = canvas.getContext('2d');
  window.jelantahChartInstance = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels.length > 0 ? labels : ['Belum Ada Data'],
      datasets: [{
        label: 'Minyak Jelantah (KG)',
        data: dataValues.length > 0 ? dataValues : [0],
        backgroundColor: '#10b981',
        borderColor: '#059669',
        borderWidth: 1.5,
        borderRadius: 8,
        barPercentage: 0.6
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: function (context) {
              return ` Total: ${context.parsed.y} KG`;
            }
          }
        }
      },
      scales: {
        y: {
          beginAtZero: true,
          title: { display: true, text: 'Jumlah (KG)' },
          grid: { color: 'rgba(0, 0, 0, 0.05)' }
        },
        x: {
          grid: { display: false },
          ticks: { font: { size: 11 } }
        }
      }
    }
  });
}

function openEditJelantahModal(r) {
  const modal = document.getElementById('modal-edit-jelantah');
  if (!modal) return;

  document.getElementById('edit-jelantah-id').value = r.id;
  document.getElementById('edit-jelantah-tanggal').value = r.tgl || r.tanggal;

  const kwSelect = document.getElementById('edit-jelantah-kwarran');
  const kwVal = String(r.kwarran || r.dari || '').trim();
  if (kwSelect) {
    let found = false;
    for (let i = 0; i < kwSelect.options.length; i++) {
      const optVal = kwSelect.options[i].value.trim().toLowerCase();
      const optText = kwSelect.options[i].text.trim().toLowerCase();
      const targetVal = kwVal.toLowerCase();
      if (optVal === targetVal || optText === targetVal || (targetVal && optVal.includes(targetVal)) || (targetVal && targetVal.includes(optVal))) {
        kwSelect.selectedIndex = i;
        found = true;
        break;
      }
    }
    if (!found && kwVal) {
      const newOpt = document.createElement('option');
      newOpt.value = kwVal;
      newOpt.textContent = kwVal;
      newOpt.selected = true;
      kwSelect.appendChild(newOpt);
    }
  }

  document.getElementById('edit-jelantah-kg').value = parseKgNumber(r.kg || r.nominal);
  document.getElementById('edit-jelantah-keterangan').value = r.keterangan || (r.guna && !r.guna.startsWith('PENGAMBILAN MINYAK JELANTAH') ? r.guna : '') || '';

  if (jelantahEditDokDropzone) jelantahEditDokDropzone.reset();
  if (jelantahEditNotaDropzone) jelantahEditNotaDropzone.reset();
  jelantahEditDokFiles = [];
  jelantahEditNotaFiles = [];

  const indDok = document.getElementById('edit-jelantah-dok-indicator');
  const indNota = document.getElementById('edit-jelantah-nota-indicator');
  if (r.attachment && (Array.isArray(r.attachment) ? r.attachment.length > 0 : true)) {
    const count = Array.isArray(r.attachment) ? r.attachment.length : 1;
    if (indDok) indDok.innerHTML = `<span style="color: #059669; font-size: 0.78rem; font-weight: 600;">Sudah ada ${count} berkas tersimpan. (Pilih berkas baru jika ingin memperbarui)</span>`;
  } else {
    if (indDok) indDok.textContent = '';
    if (indNota) indNota.textContent = '';
  }

  modal.classList.add('open');
  modal.classList.add('active');

  const closeModal = () => {
    modal.classList.remove('open');
    modal.classList.remove('active');
  };
  const btnCloseHeader = document.getElementById('btn-close-jelantah-edit');
  const btnCloseFooter = document.getElementById('btn-cancel-jelantah-edit');
  if (btnCloseHeader) btnCloseHeader.onclick = closeModal;
  if (btnCloseFooter) btnCloseFooter.onclick = closeModal;
}

function parseJelantahRow(row) {
  if (!row) return null;

  const rawTanggal = row.tanggal || row.tgl || row.Tanggal || row.Tgl || row['Tanggal Transaksi'];
  const rawKwarran = row.kwarran || row.dari || row.nama || row['Nama Kwarran'] || row['Diterima Dari'] || row.Kwarran || row.Dari || row.Nama;
  const rawKg = row.kg || row.nominal || row['Nominal / Jumlah'] || row['Jumlah (KG)'] || row.Jumlah || row.Nominal || row.KG;
  const rawGuna = row.keterangan || row.guna || row.Keperluan || row.Keterangan || row.Catatan || row.Guna;

  // Ignore blank rows
  if (!rawTanggal && !rawKwarran && !rawKg && !rawGuna) return null;

  const rawId = row.id || row.ID || row['Id'] || row['No. Kwitansi'] || row['No.'] || row.no;
  const id = rawId ? String(rawId).replace(/^No\.\s*/i, '').trim() : generateUniqueId('JLT');
  const tanggal = formatDateString(rawTanggal);
  const kwarran = String(rawKwarran || '-').trim();
  const kg = parseKgNumber(rawKg);
  const keterangan = String(rawGuna || '-').trim();
  const dateCreated = row.dateCreated || row['Date Created'] || new Date().toISOString();

  let attachment = null;
  const rawBukti = row.bukti || row.Bukti || row.attachment || row.Attachment || row['Bukti'] || row['Lampiran'];
  if (rawBukti) {
    if (Array.isArray(rawBukti)) {
      attachment = rawBukti;
    } else {
      const urls = String(rawBukti).split(',').map(s => s.trim()).filter(Boolean);
      if (urls.length > 0) attachment = urls;
    }
  }

  return {
    id: id || generateUniqueId('JLT'),
    tanggal: tanggal,
    tgl: tanggal,
    kwarran: kwarran,
    dari: kwarran,
    kg: kg,
    nominal: `${kg} KG`,
    terbilang: row.terbilang || row.Terbilang || `${terbilangKg(kg)} KILOGRAM`,
    keterangan: keterangan,
    guna: (keterangan && keterangan !== '-') ? (keterangan.toUpperCase().startsWith('PENGAMBILAN') || keterangan.toUpperCase().startsWith('PERSYARATAN') ? keterangan : `PENGAMBILAN MINYAK JELANTAH (${keterangan})`) : 'PENGAMBILAN MINYAK JELANTAH',
    penerima: row.penerima || row.Penerima || 'Tri Soma Ananta Rahman',
    nta: row.nta || row['NTA / Jabatan'] || 'Ketua Panitia',
    attachment: attachment,
    dateCreated: dateCreated
  };
}

async function deleteJelantahRecord(id) {
  if (!confirm('Apakah Anda yakin ingin menghapus catatan pengambilan jelantah ini?')) return;

  const idStr = String(id);

  // 1. Simpan ke tombstone agar autoPull tidak menarik kembali
  try {
    await saveToStore(STORE_DELETED_IDS, { id: idStr, type: 'jelantah', deletedAt: new Date().toISOString() });
  } catch (e) { }

  // 2. Hapus dari state jelantah & storage
  state.jelantahRecap = (state.jelantahRecap || []).filter(r => String(r.id) !== idStr);
  try { await deleteFromStore(STORE_JELANTAH, idStr); } catch (e) { }
  try { localStorage.setItem('jelantah_recap_data', JSON.stringify(state.jelantahRecap)); } catch (e) { }

  // 3. Hapus dari state kwitansi / sponsorship & storage
  state.sponsorshipHistory = (state.sponsorshipHistory || []).filter(h => String(h.id) !== idStr);
  try { await deleteFromStore(STORE_SPONSORSHIPS, idStr); } catch (e) { }
  try { localStorage.setItem('sponsorship_history', JSON.stringify(state.sponsorshipHistory)); } catch (e) { }

  // 4. Kirim ke Google Sheets
  if (state.settings.sheetUrl) {
    try {
      await fetch(state.settings.sheetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ action: 'delete_jelantah', id: idStr })
      });
      await fetch(state.settings.sheetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify({ action: 'delete_kwitansi', id: idStr })
      });
      try { await deleteFromStore(STORE_DELETED_IDS, idStr); } catch (e) { }
    } catch (err) {
      console.warn('Gagal delete jelantah di Sheet langsung, tombstone tersimpan:', err);
    }
  }

  showToast('Catatan Dihapus', 'Data recap jelantah berhasil dihapus.', 'info');
  renderJelantahSection();
  renderSponsorshipHistoryTable();
  renderDashboard();
}

async function syncJelantahToSheets(rec) {
  if (!state.settings.sheetUrl) return;
  try {
    const cleanJlt = {
      id: rec.id,
      tanggal: rec.tgl || rec.tanggal,
      tgl: rec.tgl || rec.tanggal,
      kwarran: rec.kwarran || rec.dari,
      dari: rec.dari || rec.kwarran,
      kg: rec.kg,
      nominal: `${rec.kg} KG`,
      terbilang: rec.terbilang || `${terbilangKg(rec.kg)} KILOGRAM`,
      keterangan: rec.keterangan || rec.guna || '-',
      guna: rec.guna || (rec.keterangan ? `PENGAMBILAN MINYAK JELANTAH (${rec.keterangan})` : 'PENGAMBILAN MINYAK JELANTAH'),
      penerima: rec.penerima || 'Tri Soma Ananta Rahman',
      attachment: rec.attachment || null,
      dateCreated: rec.dateCreated || new Date().toISOString()
    };

    await fetch(state.settings.sheetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ action: 'sync_jelantah', jelantah: cleanJlt })
    });
  } catch (err) {
    console.error('Failed to sync jelantah to sheet:', err);
  }
}

function exportJelantahExcel() {
  const records = getJelantahRecords();
  if (records.length === 0) {
    showToast('Export Gagal', 'Tidak ada data jelantah untuk diekspor.', 'error');
    return;
  }
  const headers = ['No', 'Tanggal', 'Nama Kwarran', 'Jumlah (KG)', 'Keterangan', 'Petugas'];
  const rows = records.map((r, i) => [
    i + 1,
    r.tgl || r.tanggal,
    r.dari || r.kwarran || r.nama,
    r.nominal || `${r.kg || 0} KG`,
    r.guna || r.keterangan,
    r.penerima || 'Tri Soma Ananta Rahman'
  ]);
  downloadCSVFile([headers, ...rows], `Recap_Minyak_Jelantah_${new Date().toISOString().split('T')[0]}.csv`);
  showToast('Ekspor Berhasil', 'Data jelantah siap dibuka di Excel.', 'success');
}

function exportJelantahCSV() {
  exportJelantahExcel();
}

