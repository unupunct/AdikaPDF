# Generates tests/fixtures/word-sample.xps with Microsoft Word (COM).
# Run once:  powershell -NoProfile -ExecutionPolicy Bypass -File tests\fixtures\make-xps.ps1
# Writes word-sample.xps and word-sample.json (page count reported by Word).
# Pure ASCII on purpose (PS 5.1 reads no-BOM scripts as ANSI); diacritics
# are built from code points.
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$xps = Join-Path $here 'word-sample.xps'
$json = Join-Path $here 'word-sample.json'

function U([int[]]$cps) { -join ($cps | ForEach-Object { [char]$_ }) }
# a-breve, a-circumflex, i-circumflex, s-comma, t-comma, and capitals
# (PowerShell variables are case-insensitive: capitals need distinct names)
$ab = U 0x103; $ac = U 0xE2; $ic = U 0xEE; $sc = U 0x219; $tc = U 0x21B
$uAB = U 0x102; $uSC = U 0x218; $uTC = U 0x21A

$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
try {
  $doc = $word.Documents.Add()
  $sel = $word.Selection

  $sel.Style = $doc.Styles.Item(-2)   # wdStyleHeading1
  $sel.TypeText('Raport XPS de test')
  $sel.TypeParagraph()

  $sel.Style = $doc.Styles.Item(-1)   # wdStyleNormal
  $para = "Acest paragraf con${tc}ine diacritice rom${ac}ne${sc}ti: ${ab} ${ac} ${ic} ${sc} ${tc} ${uAB} ${uSC} ${uTC}. " +
          "Cuv${ic}ntul ${sc}coal${ab} ${sc}i ${tc}ar${ab} apar ${ic}n text."
  $sel.TypeText($para)
  $sel.TypeParagraph()

  $range = $sel.Range
  $table = $doc.Tables.Add($range, 3, 3)
  $table.Borders.Enable = 1
  $cells = @(
    @('Produs', 'Cantitate', 'Pret'),
    @('Mere', '10', '25'),
    @('Pere', '7', '31')
  )
  for ($r = 0; $r -lt 3; $r++) {
    for ($c = 0; $c -lt 3; $c++) {
      $table.Cell($r + 1, $c + 1).Range.Text = $cells[$r][$c]
    }
  }
  $sel.EndKey(6) | Out-Null           # wdStory
  $sel.TypeParagraph()
  $sel.InsertBreak(7)                 # wdPageBreak
  $sel.TypeText('Pagina a doua: text dupa tabel.')

  # msoShapeRoundedRectangle = 5
  $shape = $doc.Shapes.AddShape(5, 90, 400, 200, 80)
  $shape.Fill.ForeColor.RGB = 0x3366CC
  $shape.TextFrame.TextRange.Text = 'Forma inserata'

  $pages = $doc.ComputeStatistics(2)  # wdStatisticPages
  $doc.SaveAs2([string]$xps, 18)    # wdFormatXPS
  $doc.Close(0)
  "{ `"pages`": $pages }" | Out-File -FilePath $json -Encoding ascii
  Write-Output "pages=$pages"
}
finally {
  $word.Quit()
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null
}
