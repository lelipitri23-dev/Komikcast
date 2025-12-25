# KomiCast - Web Baca Komik (Manga/Manhwa/Manhua)

KomiCast adalah aplikasi web *content aggregator* untuk membaca komik (Manga, Manhwa, Manhua) yang dibangun menggunakan **Node.js**, **Express**, dan **MongoDB**. Aplikasi ini dilengkapi dengan fitur *scraping* otomatis, manajemen admin, dan optimasi SEO (Sitemap XML bergaya Yoast).

## 🌐 Live Demo & Preview

Lihat aplikasi yang sudah berjalan (Live Preview) di sini:  
👉 **[https://komikcast.help](https://komikcast.help)**

![Preview Tampilan KomiCast](https://github.com/lelipitri23-dev/Komikcast/blob/main/694af7103cf560251f3b6765.png?raw=true)

---

## 🚀 Fitur Utama

* **Sistem Scraping Otomatis**: 
    * Mengambil data komik (judul, cover, chapter, genre, dll) dari sumber URL.
    * **Auto-Update Cron Job**: Mengecek update chapter baru setiap jam secara otomatis.
* **Admin Panel**:
    * Dashboard terlindungi password.
    * Input URL manual untuk scraping massal.
    * Monitoring status komik.
* **User Interface (Frontend)**:
    * Halaman Utama, Daftar Komik (Filter Genre, Status, Tipe, Sorting), Populer, dan Project.
    * Pencarian Komik (Search) dengan pagination.
    * Halaman Baca Chapter dengan navigasi antar chapter.
    * Fitur Bookmark (Client-side).
* **SEO Optimization**:
    * **Dynamic XML Sitemap**: Mendukung indeks sitemap, page sitemap, dan sitemap komik yang terpaginasi (mirip Yoast SEO).
    * `robots.txt` otomatis yang terintegrasi.
    * Meta tags dinamis (diimplementasikan di View).
* **Keamanan Dasar**:
    * Proteksi Admin Route menggunakan Session.
    * Rate limiting sederhana pada proses scraping manual.

## 🛠️ Teknologi yang Digunakan

* **Backend**: Node.js, Express.js
* **Database**: MongoDB (via Mongoose)
* **Templating Engine**: EJS
* **Task Scheduling**: Node-cron
* **Environment**: Dotenv

## 📂 Struktur Folder

```text
/
├── models/             # Schema Database (Manga.js, Chapter.js)
├── public/             # File statis (CSS, Images, JS Client)
├── services/           # Logika Scraper (scraper.js)
├── views/              # Template EJS (index, detail, admin, dll)
├── .env                # Variabel Lingkungan (Tidak di-commit)
├── server.js           # Entry point aplikasi
└── package.json        # Dependensi project
