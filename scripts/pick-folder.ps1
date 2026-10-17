Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '选择已经整理好的审美材料文件夹（保留原件位置）'
$dialog.ShowNewFolderButton = $false
try {
    if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
        [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
        [Console]::Write($dialog.SelectedPath)
    }
} finally { $dialog.Dispose() }
