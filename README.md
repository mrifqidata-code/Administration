# Administration — Center Ranking

Dashboard akurasi administrasi **per center, per bulan**, dengan ranking dari yang terbaik sampai yang terburuk. Dashboard ini dibangun di dalam spreadsheet **Audit System New 1** lewat Apps Script (`apps-script/CenterRanking.gs`).

## Yang dibuat script

| Tab | Isi |
| --- | --- |
| **Center Ranking** | Dashboard: pilih bulan di sel kuning (C4). Isinya KPI (jumlah center yang akurat, center terbaik/terburuk, rata-rata skor), tabel ranking terbaik → terburuk, grafik skor, tren skor & tren ranking semua bulan. |
| **Center Ranking Data** | Satu baris per center per bulan: rank, skor, status, Days Pass % per kategori, Month Accuracy. |
| **Center Category Detail** | Satu baris per center × kategori × bulan: hari aktif, hari lolos, jumlah record, verdict PASS/FAIL (untuk audit trail). |

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
2. Klik **+** di samping *Files* → **Script**, beri nama `CenterRanking`.
3. Hapus isi default-nya, lalu tempel seluruh isi `apps-script/CenterRanking.gs`. Klik **Save**.
4. Di dropdown fungsi (toolbar atas), pilih **`installCenterRanking`** lalu klik **Run**. Setujui izin yang diminta.
5. Kembali ke spreadsheet. Tab **Center Ranking** sudah muncul, dan ada menu baru **📊 Center Ranking**.

Setelah itu data di-refresh otomatis **setiap jam**. Kalau mau update sekarang juga: **📊 Center Ranking → Refresh now**.

> Script ini **tidak** memakai nama `onOpen`, jadi tidak bentrok dengan script lain yang mungkin sudah ada di spreadsheet ini.

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

Test ini menguji logika perhitungan (klasifikasi, hari lolos, Days Pass %, ranking, dan tie-break) tanpa perlu Google Sheets.
