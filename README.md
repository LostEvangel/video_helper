# Video Helper

Video Helper 是 Windows 10/11 x64 桌面工具，可下載已結束的 HLS 播放清單，並把選定時間的畫面寫成 MP4 內嵌封面。封面隨影片檔案一起複製與改名；其他電腦能否在檔案總管顯示指定封面，取決於該電腦的縮圖處理器。

## 啟動與打包

需要 Node.js 22.12 或更新版本。安裝相依套件後，可啟動開發版：

```powershell
npm install
npm run dev
```

開發版可透過 `FFMPEG_PATH` 與 `FFPROBE_PATH` 指向本機執行檔，也可從 `PATH` 找到 `ffmpeg.exe` 和 `ffprobe.exe`。發布版固定使用安裝目錄內的 `resources\bin\ffmpeg.exe` 和 `resources\bin\ffprobe.exe`，不讀取這些環境變數，也不依賴電腦另裝的 FFmpeg。

建立 Windows x64 安裝包與獨立外掛 ZIP：

```powershell
npm run typecheck
npm test
npm run build
npm run dist
```

主程式安裝包位於 `release\VideoHelper-Setup.exe`；可選縮圖外掛另存於 `release\VideoHelperThumbnail-0.1.0-win-x64.zip`。主程式安裝不會註冊外掛。安裝後可從「偏好設定 → Windows 整合 → 縮圖外掛」選擇啟用或解除安裝。也可解壓獨立 ZIP，執行其中的 `install.ps1` 或 `uninstall.ps1` 管理目前 Windows 使用者的縮圖註冊。移除主程式可從 Windows「設定 → 應用程式」解除安裝。

FFmpeg 8.1.2 essentials x64 靜態建置以 GPL-3.0 授權散布。版本、來源提交、建置設定、來源壓縮檔與執行檔 SHA-256 記錄於 `vendor\ffmpeg\README.md`、`vendor\ffmpeg\README.txt`、`vendor\ffmpeg\source.json`；授權全文隨主程式安裝在 `resources\bin\LICENSE`。

## 本機播放清單與基礎 URL

本機 `.m3u8` 可引用同目錄分片，或填寫基礎 URL 讀取網路分片。例如清單含有 `segments/001.ts`，基礎 URL 設為：

```text
https://media.example.test/season-1/
```

資源會解析為 `https://media.example.test/season-1/segments/001.ts`。目錄型基礎 URL 要以 `/` 結尾。完整 HTTP/HTTPS 資源 URL 會直接使用；程式不會猜測或附加基礎 URL 的簽名查詢參數。若未填基礎 URL，相對路徑會以本機 `.m3u8` 所在目錄為準。

## 封面相容性

封面寫入支援 MP4，保留原有音訊與影片編碼；也能另存 JPG。MKV 可選時間與匯出 JPG，但本版不承諾將封面寫入 MKV 或由檔案總管原生顯示。

在 Windows 10 Pro 22H2 build 19045.6093 上，預設 Shell 縮圖 API 對測試 MP4 讀取了內嵌 `covr` 封面。這是 Shell API 的本機結果，沒有在 Explorer 視窗目視確認，亦未在第二台電腦或 Windows 11 驗證。若電腦上的預設處理器不顯示內嵌封面，可選擇啟用隨附的 x64 縮圖外掛。外掛會優先讀取內嵌 JPEG/PNG，缺少或損壞封面時以 Media Foundation 影片畫面回退；啟用後仍需確認 Windows 檔案總管已開啟縮圖顯示。

## 驗證與發行記錄

此次主程式打包與實際安裝驗收結果、產物大小與 SHA-256 及未驗證項目記錄於 [`docs/verification/release.md`](docs/verification/release.md)。其中指向本機驗證截圖的連結屬於原工作目錄記錄，臨時驗證檔案不包含在 Git 倉庫中。

Git 倉庫不包含安裝包、工具快取、產生的測試影片及 FFmpeg 大型執行檔。從倉庫重新打包前，請按照 `vendor/ffmpeg/source.json` 的來源與 SHA-256 準備 `vendor/ffmpeg/ffmpeg.exe` 和 `vendor/ffmpeg/ffprobe.exe`；打包腳本會檢查版本對應的大小和雜湊。原生縮圖外掛的建置說明見 `native/thumbnail/README.md`。
