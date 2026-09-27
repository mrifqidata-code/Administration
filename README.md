# Administration — Center Ranking

Dashboard akurasi administrasi **per center, per bulan**, dengan ranking dari yang terbaik sampai yang terburuk. Dashboard ini dibangun dengan Apps Script di spreadsheet **Audit System New 1**, dan tersedia dalam dua bentuk:

1. **Web app dashboard**: halaman ringan yang dibuka lewat link (`apps-script/Dashboard.html`). Datanya live dari Sheet.
2. **Tab di spreadsheet**: tab `Center Ranking` beserta dua tab datanya (`apps-script/CenterRanking.gs`).

## Web app dashboard

Isinya:

- Pilihan bulan. Bulan yang dipilih akan diingat di browser.
- Kartu ringkasan: jumlah center yang akurat, center terbaik, center terburuk, dan rata-rata skor.
- **Ranking terbaik → terburuk**: bar skor dengan garis target 90%, status ✓ Akurat / ✗ Tidak akurat, jumlah kategori PASS, dan ▲/▼ perubahan peringkat dibanding bulan lalu. Arahkan kursor ke baris untuk melihat rincian per kategori.
- **Days Pass % per kategori**: matriks center × 5 kategori (✓ PASS / ✗ FAIL) dan Month Accuracy. Arahkan kursor ke sel untuk melihat hari lolos dan jumlah record.
- **Detail center**: klik center di ranking atau tabel (atau pilih lewat tombol center). Muncul 5 kartu kategori, masing-masing berisi:
  - Days Pass %, jumlah hari lolos, record lengkap vs tidak lengkap, dan Month Accuracy.
  - **Kalender harian**: hijau = hari lolos, merah = hari gagal, abu-abu = tidak ada record. Arahkan kursor atau ketuk tanggal untuk melihat Daily %.
  - **Field kosong teratas**: kolom yang paling sering kosong di record yang tidak lengkap (kode kolom seperti `BK` otomatis diterjemahkan ke nama header).
- Tampilan menyesuaikan HP dan mode gelap.

## Yang dibuat script

| Tab | Isi |
| --- | --- |
| **Center Category Detail** | Selalu ditulis saat refresh (tiap jam). Satu baris per center × kategori × bulan: hari aktif, hari lolos, jumlah record, verdict PASS/FAIL. Web app membaca data dari tab ini. |
| **Center Daily Detail** | Selalu ditulis saat refresh. Satu baris per center × kategori × hari: jumlah record, record lengkap, Daily %, lolos/gagal. Sumber data kalender harian. |
| **Center Missing Fields** | Selalu ditulis saat refresh. Jumlah record tidak lengkap per center × kategori × bulan × kolom yang kosong (diambil dari kolom `Missing Field(s)` di tiap sheet). |
| **Center Ranking** *(opsional)* | Dibuat lewat menu **📊 Center Ranking → Build / update the Center Ranking tab**. Pilih bulan di sel kuning (C4). Isinya KPI (jumlah center yang akurat, center terbaik/terburuk, rata-rata skor), tabel ranking terbaik → terburuk, grafik skor, tren skor & tren ranking semua bulan. |
| **Center Ranking Data** *(opsional)* | Dibuat bersama tab di atas. Satu baris per center per bulan: rank, skor, status, Days Pass % per kategori, Month Accuracy. |

Tab dashboard di spreadsheet tidak ikut digambar ulang setiap jam, karena menggambarnya lambat untuk spreadsheet sebesar ini. Kalau kamu ingin tab itu ikut diperbarui otomatis, ubah `BUILD_SHEET_TAB_ON_REFRESH` menjadi `true`.

## Cara hitung

Sama dengan tab **Audit Dashboard** yang sudah ada:

1. **Daily %** = record lengkap / record yang diaudit, per center, per kategori, per hari. Baris `N/A` (mis. no-show Register Trial) tidak dihitung.
2. **Hari lolos** kalau Daily % ≥ **80%**.
3. **Days Pass %** = hari lolos / hari aktif dalam bulan itu. Hari tanpa record tidak dihitung.
4. **Kategori PASS** kalau Days Pass % ≥ **90%**.
5. **Skor center** = rata-rata Days Pass % dari 5 kategori (bobot sama). Kategori tanpa record di bulan itu tidak dihitung (bukan dianggap gagal).
6. **ACCURATE** = semua kategori yang punya record berstatus PASS.
7. **Ranking** = skor tertinggi dulu. Kalau seri, pemenangnya yang lebih banyak kategori PASS, lalu yang Month Accuracy-nya lebih tinggi.

Ada 5 kategori, dengan sheet sumber masing-masing:

| Kategori | Sheet sumber | Tanggal yang dipakai |
| --- | --- | --- |
| Register Trial | `REGISTER TRIAL` | Period Key + Day |
| Payment Record | `PAYMENT RECORD` | Period Key + Payment Day |
| Student Database | `STUDENT DATABASE` | Period Key + Regist Day |
| Schedule Mgmt (Student Management) | `SCHEDULE MANAGEMENT` | Period Key + Day |
| Attendance Log | `Attendance Log` | Period Key + Day |

Script mencari kolom berdasarkan **nama header di baris 1** (`Center`, `Audit Result`/`Audit Flag`, `Period Key`, `Day`), jadi aman kalau posisi kolom bergeser.

## Cara pasang (sekali saja)

1. Buka spreadsheet **Audit System New 1** → menu **Extensions → Apps Script**.
2. Klik **+** di samping *Files* → **Script**, beri nama `CenterRanking`. Hapus isi default-nya, tempel seluruh isi `apps-script/CenterRanking.gs`, lalu klik **Save**.
3. Klik **+** → **HTML**, beri nama **`Dashboard`** (harus persis, tanpa `.html`). Hapus isi default-nya, tempel seluruh isi `apps-script/Dashboard.html`, lalu klik **Save**.
4. **Aktifkan Google Sheets API** supaya pembacaan data jauh lebih cepat: di panel kiri, klik **+** di samping *Services* → pilih **Google Sheets API** → **Add**. Identifier-nya harus tetap `Sheets`.
5. Di dropdown fungsi (toolbar atas), pilih **`installCenterRanking`** lalu klik **Run**. Setujui izin yang diminta.
6. Kembali ke spreadsheet. Tab **Center Category Detail** sudah terisi, dan ada menu baru **📊 Center Ranking**.

Setelah itu data di-refresh otomatis **setiap jam**. Kalau mau update sekarang juga: **📊 Center Ranking → Refresh now**.

### Kalau refresh terasa lama

Buka **Executions** di editor Apps Script, lalu klik salah satu run. Log-nya mencatat waktu setiap langkah, contohnya:

```
12.4s  read raw sheets (RT 29973, PR 13786, SD 23185, SM 11987, AL 41130 rows)
0.8s  calculate (360 center × category × month rows)
1.1s  write "Center Category Detail"
TOTAL 14.3s  done
```

- Kalau muncul `Tip: enable Services → Google Sheets API`, berarti langkah 4 belum dilakukan.
- Kalau langkah `read raw sheets` yang lama, biasanya spreadsheet sedang menghitung ulang formulanya. Script harus menunggu perhitungan itu selesai.

### Membuat link web app

1. Di editor Apps Script, klik **Deploy → New deployment**.
2. Klik ikon ⚙️ di sebelah *Select type*, lalu pilih **Web app**.
3. Isi pengaturannya:
   - *Description*: `Center Ranking`
   - *Execute as*: **Me**. Dengan begitu yang membuka link tidak perlu punya akses ke spreadsheet.
   - *Who has access*: **Anyone within seven-retail.com** (hanya akun kantor), atau pilih sesuai kebutuhan.
4. Klik **Deploy**, lalu salin **Web app URL**. Link itulah dashboard-nya.

Kalau script diubah nanti: buka **Deploy → Manage deployments → ✏️ Edit**, pilih *Version: New version*, lalu klik **Deploy**. Link-nya tetap sama.

> Script ini **tidak** memakai nama `onOpen`, jadi tidak bentrok dengan script lain yang mungkin sudah ada di spreadsheet ini. Tapi script ini memakai `doGet` untuk web app. Kalau project Apps Script-nya sudah punya fungsi `doGet`, kabari dulu.

## Mengubah standar

Ubah `DAILY_MIN` dan `MONTH_PASS` di bagian atas `CenterRanking.gs` supaya sama dengan tab **Settings**, lalu jalankan **Refresh now**.

## Cek hasil

Buka **Center Ranking**, pilih **Aug 2026**, lalu bandingkan kolom per kategori dengan tabel *BRANCH x CATEGORY — DAYS PASS %* di tab **Audit Dashboard** (contoh: KLM seharusnya Register Trial 17%, Student Database 21%). Kalau angkanya beda, berarti ada nilai `Audit Result` yang belum dikenali script. Script mengenali:

- **Lengkap**: `✅ VALID`
- **Tidak lengkap**: yang mengandung `❌`, `INCOMPLETE`, atau `INVALID`
- **Tidak diaudit**: kosong, diawali `N/A`, atau error `#...`

## Test

```bash
node --test
```

Test ini menguji logika perhitungan (klasifikasi, hari lolos, Days Pass %, ranking, tie-break) dan data untuk web app tanpa perlu Google Sheets.
