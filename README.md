# Android ZIP Builder — GitHub Pages + GitHub Actions

Web builder pribadi untuk alur:

**upload project Android `.zip` → GitHub Actions build → APK otomatis terdownload**

Tidak ada JDK/Gradle/Android SDK yang berjalan di HP. Semua compile dilakukan oleh GitHub Actions.

## Desain v1

- Frontend: GitHub Pages (`index.html`, `styles.css`, `app.js`).
- Upload project: **draft GitHub Release**, sehingga ZIP tidak pernah masuk commit history.
- Build: GitHub Actions pada `ubuntu-latest`.
- Jika project punya Gradle Wrapper, wrapper selalu dipakai.
- Jika wrapper hilang, builder mendeteksi AGP dan memilih fallback Gradle yang dikenal.
- JDK dipilih dari versi AGP.
- `compileSdk` dideteksi dan platform Android dipastikan tersedia.
- Hasil APK ditempel ke draft release dan frontend mengunduh APK langsung.
- ZIP sumber dihapus setelah build sukses.
- Draft release hasil dihapus setelah download untuk build satu APK.
- Jika Gradle gagal, builder mencoba menampilkan `build.log` langsung di web sebelum cleanup.
- Draft sisa lebih dari 24 jam dibersihkan oleh workflow terjadwal.

## Testcase pertama

Project `CombinedWallpaper_Enhanced_v25_burst_wallpaper_dorothy_audiofix`:

- AGP `8.6.1`
- `compileSdk 35`
- `targetSdk 35`
- `minSdk 26`
- Java
- tidak mempunyai Gradle Wrapper

Builder akan memilih **Gradle 8.7 + JDK 17** untuk project tersebut.

## Setup sekali saja

### 1. Buat repository

Buat repository GitHub, misalnya:

`android-zip-builder`

Untuk GitHub Pages + Actions gratis tanpa kuota private-repo minutes, repository dapat dibuat **Public**. Project yang diupload tetap ditempatkan sebagai **draft release**, bukan public release dan bukan commit.

Upload seluruh isi folder ini ke root repository.

### 2. Aktifkan GitHub Pages

Repository → **Settings → Pages**

- Source: `Deploy from a branch`
- Branch: `main`
- Folder: `/ (root)`

Website kemudian tersedia di:

`https://USERNAME.github.io/android-zip-builder/`

### 3. Buat Fine-grained Personal Access Token

GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens.

Batasi token hanya ke repository builder ini.

Repository permissions minimum:

- **Actions: Read and write** — memicu workflow dan membaca status build.
- **Contents: Read and write** — membuat draft release, upload/download APK, dan cleanup.

Tidak perlu menaruh token di file repository. Masukkan token melalui tombol pengaturan di web builder.

Default-nya token hanya disimpan di `sessionStorage` browser. Opsi “ingat token” menyimpannya ke `localStorage`; gunakan hanya di perangkat pribadi.

### 4. Tes

1. Buka web builder.
2. Isi owner, repo, branch, dan token.
3. Tekan **Tes koneksi**.
4. Pilih project Android `.zip`.
5. Pilih `Debug`.
6. Tekan **BUILD APK**.
7. Setelah workflow selesai, satu APK akan otomatis didownload. Jika ada beberapa APK (misalnya multi-module/flavor), web menampilkan tombol download untuk masing-masing.

## Batas kompatibilitas v1

Mendukung project Gradle Android normal selama toolchain project dapat berjalan pada GitHub hosted runner. Project dengan wrapper adalah yang paling kompatibel.

Fallback tanpa wrapper saat ini sengaja konservatif dan mengenali AGP umum hingga 8.9. Versi AGP yang lebih baru/aneh tanpa wrapper akan dihentikan dengan error jelas daripada menebak versi Gradle.

Hal yang tetap bergantung pada project:

- custom Maven repository yang memerlukan credential,
- signing key release pribadi,
- secrets Firebase/Google yang tidak ada di ZIP,
- dependency yang hanya tersedia di jaringan internal,
- workflow/build script yang memang rusak,
- toolchain custom di luar Gradle/Android standar.

## Keamanan penting

Project ZIP adalah **kode yang akan dieksekusi** oleh Gradle. Workflow build tidak memberikan write token ke step Gradle dan `actions/checkout` memakai `persist-credentials: false`. Job yang memiliki `contents: write` hanya menerima APK hasil artifact dan tidak menjalankan source project pengguna.

Jangan menambahkan repository secrets sensitif ke job `build` kecuali kamu benar-benar mempercayai project ZIP yang diupload.

## File utama

- `.github/workflows/build-apk.yml` — build + publish APK.
- `.github/workflows/cleanup-drafts.yml` — cleanup draft lama.
- `scripts/safe_extract.py` — ekstraksi ZIP dengan proteksi path traversal/ZIP bomb dasar.
- `scripts/detect_toolchain.py` — deteksi root project, AGP, wrapper, JDK, Gradle, compileSdk.
- `app.js` — upload draft release, trigger workflow, polling status, download APK.
