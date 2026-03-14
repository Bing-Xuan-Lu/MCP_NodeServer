---
name: windows_node_autostart
description: |
  在 Windows 設定 Node.js 服務開機自動啟動，使用 VBS 單例保護 + Task Scheduler XML 確保靜默無視窗執行。涵蓋：VBS 單例包裝腳本、Task Scheduler XML 建立、PS1 一鍵重新註冊、開機延遲避免網路搶佔。
  當使用者說「node 開機自啟」「自動啟動服務」「背景執行 node」「task scheduler node」時使用。
---

# /windows_node_autostart — Windows Node.js 開機自動啟動（VBS 單例 + Task Scheduler）

## 背景
當需要在 Windows 登入後自動啟動一個 Node.js 後台服務，且必須：
- 防止重複執行（單例保護）
- 不癱瘓開機網路（延遲啟動）
- 無視窗靜默執行

## 輸入
- `<SCRIPT_PATH>` — 要執行的 Node.js 腳本完整路徑（例：`D:\Develop\project\service.js`）
- `<NODE_PATH>` — Node.js 完整執行路徑（例：`C:\nvm4w\nodejs\node.exe`）
- `<TASK_NAME>` — 工作排程器任務名稱（例：`MyService`）
- `<DELAY_SECONDS>` — 開機後延遲秒數（建議 30）
- `<VBS_PATH>` — VBS 包裝腳本路徑（例：`D:\Develop\project\scripts\start-service.vbs`）
- `<XML_PATH>` — Task Scheduler XML 路徑（例：`D:\Develop\project\scripts\service-task.xml`）
- `<PS1_PATH>` — PS1 註冊腳本路徑（例：`D:\Develop\project\scripts\register-service-task.ps1`）

## 步驟

### 1. 建立 VBS 單例包裝腳本（`<VBS_PATH>`）

```vbs
' 防止重複執行：若 service.js 已在跑則直接退出
Dim objWMI, colProcess
Set objWMI = GetObject("winmgmts:{impersonationLevel=impersonate}!\\.\root\cimv2")
Set colProcess = objWMI.ExecQuery("SELECT * FROM Win32_Process WHERE CommandLine LIKE '%<SCRIPT_NAME>%'")
If colProcess.Count > 0 Then
    WScript.Quit 0
End If

' 啟動服務（隱藏視窗，不等待）
Dim WshShell
Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "<NODE_PATH> <SCRIPT_PATH>", 0, False
```

> 將 `<SCRIPT_NAME>` 替換為腳本檔名（例：`service.js`），用於 WMI 程序比對

### 2. 建立 Task Scheduler XML（`<XML_PATH>`）

```xml
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Node.js Service - starts <DELAY_SECONDS>s after logon</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <Delay>PT<DELAY_SECONDS>S</Delay>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>HighestAvailable</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>wscript.exe</Command>
      <Arguments>"<VBS_PATH>"</Arguments>
    </Exec>
  </Actions>
</Task>
```

> ⚠️ XML 必須存為 **UTF-16** 編碼，否則 schtasks 會報錯

### 3. 建立 PS1 註冊腳本（`<PS1_PATH>`）

```powershell
$taskName = "<TASK_NAME>"
$xmlPath  = "<XML_PATH>"
$vbsPath  = "<VBS_PATH>"

# Delete existing task
schtasks /delete /tn $taskName /f 2>$null

# Register from XML (supports delay + MultipleInstances IgnoreNew)
schtasks /create /tn $taskName /xml $xmlPath /f
if ($LASTEXITCODE -eq 0) {
    Write-Host "[OK] Task '$taskName' created"
} else {
    Write-Host "[FAIL] Please run as Administrator"
    exit 1
}

# Start immediately for this session
Start-Process "wscript.exe" -ArgumentList "`"$vbsPath`""
Write-Host "[OK] Started."
```

> 使用 `schtasks /create /xml` 而非 `Register-ScheduledTask`，相容性更好

### 4. 建立 XML 時注意編碼

PowerShell 預設 UTF-8 BOM，需指定 UTF-16：
```powershell
$xml | Out-File -FilePath $xmlPath -Encoding Unicode
```
或直接用 Write 工具建立，確認用 `schtasks` 讀取正常。

### 5. 以系統管理員身份執行 PS1 註冊

```powershell
# 在 PowerShell (管理員) 中執行：
PowerShell -ExecutionPolicy Bypass -File "<PS1_PATH>"
```

### 6. 驗證

```powershell
# 確認任務已建立
schtasks /query /tn "<TASK_NAME>" /fo LIST

# 確認程序已啟動（等 5 秒後）
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*<SCRIPT_NAME>*' }
```

## 輸出

- `<VBS_PATH>` — 單例保護包裝腳本
- `<XML_PATH>` — Task Scheduler 工作定義（UTF-16）
- `<PS1_PATH>` — 一鍵重新註冊腳本
- 工作排程器中出現 `<TASK_NAME>`，登入後 `<DELAY_SECONDS>` 秒自動啟動

## 關鍵注意事項

| 問題 | 原因 | 解法 |
|------|------|------|
| 登入就癱瘓網路 | 服務太早啟動，搶佔埠口 | 設定 30 秒延遲（`PT30S`） |
| 多個程序同時跑 | 快速重新登入或手動執行 | VBS WMI 單例檢查 + `IgnoreNew` 政策 |
| Task Scheduler 找不到 node | PATH 未傳入 Task Scheduler | VBS 中使用 Node.js **完整路徑** |
| schtasks 建立失敗 | 非管理員權限 | 以系統管理員身份執行 PS1 |
| XML 格式錯誤 | 編碼非 UTF-16 | 確認存檔時指定 `Unicode` 編碼 |
