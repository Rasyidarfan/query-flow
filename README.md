# QueryFlow

QueryFlow adalah Chrome Extension untuk menjalankan query SQL di FASIH SQL Lab (dibangun dari dasar Superset) dan mengunduh hasilnya sebagai file Excel.

- Integrasi: FASIH Dashboard / FASIH SQL Lab
- Contoh penggunaan parameter: SE2026 — Sensus Ekonomi 2026
- Initiated by: D.Agung Sungkono

QueryFlow adalah utilitas independen, bukan produk atau dokumentasi resmi BPS/FASIH.

## Cara Pakai

### 1. Siapkan SQL

Simpan file `.sql` di dalam folder. Jika query ingin dijalankan sebagai satu batch, kelompokkan file-file tersebut dalam subfolder yang sama. Contoh:

```text
Query/
├── Agregat/
│   ├── tabel-1.sql
│   └── tabel-2.sql
└── Mikro/
    └── tabel-3.sql
```

QueryFlow mengimpor file SQL dalam subfolder. File `.sql` yang berada langsung di root folder pilihan diabaikan.

### 2. Impor folder

1. Buka QueryFlow, lalu klik **Import Folder SQL**.
2. Pilih folder `Query` (folder induk), bukan subfolder `Agregat` atau `Mikro`.
3. Setelah daftar folder dan query muncul, pilih query yang akan dijalankan. Semua query terpilih secara default.

QueryFlow menyimpan salinan lokal (snapshot). Jika isi file SQL berubah, impor folder lagi untuk memperbarui snapshot.

### 3. Buka SQL Lab

1. Buka [FASIH SQL Lab](https://fasih-dashboard.bps.go.id/superset/sqllab/) dan login.
2. Pilih database, schema, dan LIMIT yang sesuai.
3. Buka QueryFlow dari tab SQL Lab tersebut. Jangan tutup tab atau panel selama query berjalan.

### 4. Jalankan query

- Klik **Run** di samping satu file untuk menjalankan satu query.
- Klik **Run Folder** untuk menjalankan semua query yang dipilih dalam folder secara berurutan.
 Klik **Stop** untuk menghentikan proses. Hasil yang sudah diterima tetap diunduh sebagai Excel parsial atau ZIP parsial sesuai pengaturan folder.
- Klik nama file untuk melihat SQL; gunakan **Copy** untuk menyalin SQL dengan filter wilayah yang dipilih.

Hasil setiap query menjadi satu sheet Excel. Tanpa pemisahan kolom, hasil satu folder digabung dalam satu workbook; file besar dapat dipecah menjadi beberapa bagian bernomor. Jika satu query gagal, hasil yang sudah terkumpul tetap diunduh sebagai output parsial.

### Filter wilayah

### Pisahkan hasil menurut kolom

Di pengaturan setiap folder, isi **Pisahkan berdasarkan kolom** untuk membuat workbook terpisah bagi setiap nilai unik. Kolom kedua bersifat opsional; jika diisi, setiap kombinasi kedua nilai menjadi satu workbook. Nama yang dimasukkan harus tersedia pada header hasil semua query terpilih. Pencocokan mengabaikan huruf besar/kecil dan spasi di awal/akhir.

QueryFlow memeriksa header dari hasil SQL Lab saat query mulai, tanpa menjalankan query tambahan. Jika kolom tidak ditemukan atau nama header ambigu, batch berhenti sebelum menerima baris query tersebut. Nilai kolom yang kosong atau `NULL` masuk ke kelompok `(blank)`. Batas halaman SQL tidak memulai kelompok baru; nilai yang sama tetap masuk ke workbook yang sama lintas halaman dan file SQL.

Saat pemisahan aktif, setiap checkpoint diunduh sebagai ZIP berisi workbook per kelompok dan `manifest.json`. Simpan seluruh ZIP dengan run ID yang sama. Manifest checkpoint berstatus `in_progress`; ZIP terakhir berisi status `complete` atau `incomplete`. Jika batch gagal, ZIP checkpoint yang sudah diunduh tetap ada dan ZIP terakhir menandai kegagalan serta mencantumkan checkpoint sebelumnya. Status ini penting karena checkpoint lama tidak dapat ditarik kembali dari folder Downloads.

Filter wilayah hanya diterapkan pada SQL yang menggunakan parameter `filter_provinsi` dan `filter_kabupaten`. Isi kode provinsi (Level 1) atau kode kabupaten/kota (Level 2); jika Level 2 diisi, Level 1 tidak digunakan. Biarkan keduanya kosong untuk tidak menerapkan filter wilayah dari QueryFlow.

Contoh parameter dalam SQL:

```sql
WITH param_wilayah AS (
    SELECT
        '' AS filter_provinsi,
        '' AS filter_kabupaten
)
```

## Pengaturan Lanjutan

Di setiap folder, aktifkan **Advanced settings** untuk mengatur:

- **Mulai Baris**: mulai mengambil hasil dari nomor baris ini.
- **Maks Total Baris**: batas jumlah baris yang diambil; kosong berarti tanpa batas.
- **Download Excel Tiap X Baris**: unduh hasil bertahap untuk mengurangi risiko kehilangan hasil jika proses panjang terganggu.

Pengaturan disimpan per folder. Nilai default biasanya cukup untuk penggunaan biasa.

## Database Hasil & Export Monitoring

QueryFlow menyimpan hasil setiap run di database lokal browser (IndexedDB). Yang disimpan adalah run **lengkap** terakhir per query dan per filter wilayah, ditambah riwayat run. Run parsial, run yang gagal, dan run dengan **Mulai Baris**/**Maks Total Baris** yang diubah tidak menggantikan hasil lengkap.

- **Kode anomali**: setiap query mendapat kode taskforce tetap (`T10`, `T11`, …), ditampilkan sebagai badge di samping nama file bersama jumlah record terakhir. Klik badge untuk mengganti kode. Kode lama tidak berubah saat folder diimpor ulang.
- **Hanya query yang pernah menghasilkan record**: toggle per folder. Saat aktif, Run Folder melewati query yang sudah pernah selesai dijalankan dengan SQL dan filter wilayah yang sama tetapi tidak pernah menghasilkan record. Query baru atau yang SQL-nya berubah tetap dijalankan.
- **Batas request**: eksekusi SQL ke SQL Lab dibatasi 30 per menit (jendela bergulir 60 detik) untuk semua Run dan Run Folder. Pengambilan lanjutan dari hasil yang sudah ada di SQL Lab tidak dihitung.
- **⇩ Export Monitoring (CSV)**: mengunduh hasil lengkap terakhir dari query terpilih ke `Downloads/QueryFlow-monitoring/`, satu CSV per kode (ZIP bila lebih dari satu). Formatnya adalah CSV taskforce aplikasi monitoring (halaman **Anomali**). Kolom wajibnya: `kode_anomali, nama_anomali, assignment_id, kode_sls, nama_sls, nama_objek, no_objek, status, email_pencacah, email_pengawas, updated_at`. Kolom hasil query lainnya ikut sebagai detail.

Kolom diisi otomatis dari nama kolom hasil query, tanpa membedakan huruf besar/kecil:

| Kolom monitoring | Kolom query yang dikenali |
|---|---|
| `kode_sls` (16 digit) | `kode_sls`, `kode_subsls`, `idsubsls`, `level_6_full_code` |
| `nama_sls` | `nama_sls`, `nama_subsls`, `level_6_name` |
| `nama_objek` | `nama_objek`, `nama_usaha`, `nama_kk`, `nama_kepala_keluarga`, `nama_dtsen`, `nama` |
| `no_objek` | `no_objek`, `index1`, `no_urut_kk`, `no_urut` |
| `status` | `status`, `assignment_status_alias` |
| `email_pencacah` / `email_pengawas` | `email_pencacah`, `email_petugas`, `pencacah` / `email_pengawas`, `pengawas` |
| `updated_at` | `updated_at`, `assignment_date_modified`, `date_modified`, atau waktu selesai run |

Baris tanpa `assignment_id` atau tanpa kode SLS 16 digit tidak diekspor, karena importer monitoring akan menolaknya. Ringkasan export menyebutkan query mana yang terdampak. Query dengan 0 record dan query yang belum punya run lengkap tidak diekspor.

### Push langsung ke aplikasi monitoring

Di bagian **05 Aplikasi Monitoring**, isi **URL target** (mis. `https://se-meira.bps9702.com`) dan **Token API** (nilai `REKAP_API_TOKEN` di server), lalu klik **Simpan & Tes Koneksi**. Chrome meminta izin akses ke host tersebut sekali saja.

- **⇪ Push ke Monitoring** (per folder) mengirim hasil lengkap terakhir dari query terpilih untuk wilayah aktif, satu request per kode anomali.
- **Push otomatis setelah run lengkap**: setiap query yang selesai lengkap pada Run/Run Folder langsung dikirim.
- Berbeda dengan export CSV, hasil **0 record ikut dikirim**: anomali kode itu dihapus di aplikasi monitoring, karena query tidak lagi menemukannya. Penghapusan hanya berlaku di kabupaten yang tercakup filter wilayah aktif.
- Query yang barisnya tidak punya kode SLS 16 digit tidak dikirim, supaya anomali lama tidak ikut terhapus.

Di aplikasi monitoring, satu assignment yang terjaring beberapa query tampil sebagai satu baris di tabel Rincian dengan semua kodenya (mis. `T2, T12, U5`).

> Importer monitoring menghapus baris lama dengan kode yang sama bila baris itu tidak ada di berkas baru. Karena itu, jalankan ulang query sampai lengkap sebelum export, dan jangan memakai hasil yang difilter ke sebagian wilayah untuk kode yang biasanya mencakup semua wilayah.

## Instalasi untuk Development

Perlu Node.js 20.19+ atau 22.12+.

```bash
npm install
npm run build
```

Di Chrome, buka `chrome://extensions`, aktifkan **Developer mode**, pilih **Load unpacked**, lalu pilih folder `dist/`. Setelah membangun ulang, klik **Reload** pada extension.

## Catatan

- SQL dijalankan melalui sesi FASIH SQL Lab yang sedang login. QueryFlow tidak meminta atau menyimpan username/password.
- File SQL sumber tidak diubah. Snapshot disimpan lokal di browser.
- QueryFlow menambahkan pengurutan default bila query belum memiliki `ORDER BY`. Untuk pagination yang konsisten, gunakan `ORDER BY` dengan kunci unik.
- Panel harus tetap terbuka selama proses berjalan. Fitur resume belum tersedia; menjalankan ulang folder akan mengulang query dari awal.
- Versi ini ditujukan untuk FASIH SQL Lab. Perubahan pada aplikasi FASIH/Superset dapat memengaruhi kompatibilitas.

## Changelog

### 0.5.0

- Tambah push langsung ke aplikasi monitoring (URL target & token tersimpan), manual per folder atau otomatis setelah run lengkap.

### 0.4.0

- Tambah database hasil lokal (IndexedDB): hasil lengkap terakhir per query & wilayah serta riwayat run.
- Tambah toggle per folder untuk melewati query yang tidak pernah menghasilkan record.
- Batasi eksekusi SQL ke SQL Lab maksimal 30 request per menit.
- Tambah Export Monitoring: CSV taskforce dengan kode anomali per query, siap diunggah ke aplikasi monitoring.

### 0.3.6

- Tambah ekspor workbook terpisah berdasarkan satu atau dua kolom bernama.
- Kelompokkan nilai kolom yang sama lintas halaman dan file SQL, lalu unduh checkpoint hasil sebagai ZIP.
- Validasi header kolom sebelum batch berjalan dan sertakan status kelengkapan ekspor di manifest.

### 0.3.5

- Tambah pilihan query untuk menjalankan hanya file yang dipilih dari sebuah folder.
- Tambah pengaturan per folder: baris awal, batas total baris, dan unduhan Excel berkala.
- Perbaiki pengambilan hasil besar agar transfer data SQL Lab dapat dilanjutkan per bagian.
- Tangani kondisi extension diperbarui saat panel atau service worker masih aktif.

### 0.3.4

- Tambah pengambilan hasil SQL bertahap untuk mendukung query dengan hasil besar.
- Tingkatkan ekspor Excel untuk menggabungkan hasil query dan menangani hasil parsial saat dihentikan atau terjadi error.
- Perbaiki urutan pagination serta pesan status saat query berjalan.

### 0.3.3

- Rilis awal QueryFlow untuk mengimpor kumpulan file SQL lokal dan menjalankannya di FASIH SQL Lab.
- Tambah filter parameter wilayah, eksekusi query per file atau per folder, dan ekspor hasil ke Excel.
