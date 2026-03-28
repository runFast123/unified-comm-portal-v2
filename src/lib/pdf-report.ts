import type { DateRange } from '@/components/reports/date-range-picker'

// Types for the data passed into the PDF generator
export interface PdfReportData {
  dateRange: DateRange
  customFrom?: string
  customTo?: string
  isAdmin: boolean
  // Overview
  totalMessages: number
  pendingMessages: number
  aiProcessedCount: number
  responseRate: number
  avgSentiment: string
  topCategory: string
  // Channel breakdown
  channelStats: {
    channel: string
    totalMessages: number
    resolvedRate: number
    avgResponseTime: string
    aiSentRate: number
    peakHour: string
  }[]
  // Category breakdown
  categoryBreakdown: { name: string; count: number }[]
  // AI performance
  aiMetrics: {
    totalRepliesGenerated: number
    approvalRate: number
    classificationAccuracy: number
    autoSendRate: number
    editRate: number
    totalClassifications: number
  } | null
  // Urgency distribution
  urgencyDistribution: { level: string; count: number }[]
}

function getDateRangeLabel(range: DateRange, customFrom?: string, customTo?: string): string {
  switch (range) {
    case 'today': return `Today (${new Date().toLocaleDateString()})`
    case '7d': return 'Last 7 Days'
    case '30d': return 'Last 30 Days'
    case '90d': return 'Last 90 Days'
    case 'custom':
      if (customFrom && customTo) return `${customFrom} to ${customTo}`
      return 'Custom Range'
    default: return 'Last 7 Days'
  }
}

export async function generateReport(data: PdfReportData): Promise<void> {
  // Dynamic imports for client-side only libraries
  const { default: jsPDF } = await import('jspdf')
  const autoTable = (await import('jspdf-autotable')).default

  const doc = new jsPDF('p', 'mm', 'a4')
  const pageWidth = doc.internal.pageSize.getWidth()
  const margin = 20
  const contentWidth = pageWidth - margin * 2
  const tealColor: [number, number, number] = [13, 148, 136]
  const grayColor: [number, number, number] = [107, 114, 128]
  const darkColor: [number, number, number] = [17, 24, 39]

  // Helper to add a page header
  function addPageHeader(title: string) {
    doc.setFillColor(...tealColor)
    doc.rect(0, 0, pageWidth, 12, 'F')
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(9)
    doc.setTextColor(255, 255, 255)
    doc.text('Unified Communication Portal', margin, 8)
    doc.text(title, pageWidth - margin, 8, { align: 'right' })
    doc.setTextColor(...darkColor)
  }

  // Helper to add page footer
  function addPageFooter(pageNum: number) {
    const pageHeight = doc.internal.pageSize.getHeight()
    doc.setFontSize(8)
    doc.setTextColor(...grayColor)
    doc.text(
      `Generated on ${new Date().toLocaleString()} | Page ${pageNum}`,
      pageWidth / 2,
      pageHeight - 10,
      { align: 'center' }
    )
    doc.setTextColor(...darkColor)
  }

  // ──────────────────── PAGE 1: Executive Summary ────────────────────
  addPageHeader('Executive Summary')

  let y = 24
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(22)
  doc.setTextColor(...tealColor)
  doc.text('Report', margin, y)
  y += 10

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(11)
  doc.setTextColor(...grayColor)
  doc.text(`Period: ${getDateRangeLabel(data.dateRange, data.customFrom, data.customTo)}`, margin, y)
  y += 6
  doc.text(`Scope: ${data.isAdmin ? 'All Companies (Admin)' : 'Your Account'}`, margin, y)
  y += 6
  doc.text(`Generated: ${new Date().toLocaleString()}`, margin, y)
  y += 12

  // Divider line
  doc.setDrawColor(...tealColor)
  doc.setLineWidth(0.5)
  doc.line(margin, y, pageWidth - margin, y)
  y += 10

  // KPI Summary Table
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(14)
  doc.setTextColor(...darkColor)
  doc.text('Key Performance Indicators', margin, y)
  y += 8

  const totalCat = data.categoryBreakdown.reduce((s, c) => s + c.count, 0)

  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head: [['Metric', 'Value']],
    body: [
      ['Total Messages', String(data.totalMessages)],
      ['Pending Messages', String(data.pendingMessages)],
      ['AI Processed', String(data.aiProcessedCount)],
      ['Response Rate', `${data.responseRate}%`],
      ['Average Sentiment', data.avgSentiment],
      ['Top Category', data.topCategory || 'N/A'],
      ['Total Classifications', String(totalCat)],
    ],
    theme: 'striped',
    headStyles: { fillColor: tealColor, font: 'helvetica', fontStyle: 'bold', fontSize: 10 },
    bodyStyles: { fontSize: 10 },
    columnStyles: { 0: { fontStyle: 'bold', cellWidth: 70 } },
  })

  addPageFooter(1)

  // ──────────────────── PAGE 2: Channel Breakdown ────────────────────
  doc.addPage()
  addPageHeader('Channel Breakdown')

  y = 24
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(16)
  doc.setTextColor(...darkColor)
  doc.text('Channel Performance', margin, y)
  y += 4

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(...grayColor)
  doc.text('Per-channel statistics for the selected period', margin, y + 5)
  y += 14

  const channelBody = data.channelStats.map((ch) => {
    const pct = data.totalMessages > 0 ? ((ch.totalMessages / data.totalMessages) * 100).toFixed(1) : '0'
    return [ch.channel, String(ch.totalMessages), `${pct}%`, ch.avgResponseTime, `${ch.resolvedRate}%`, `${ch.aiSentRate}%`, ch.peakHour]
  })

  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head: [['Channel', 'Messages', '% of Total', 'Avg Response', 'Resolved %', 'AI Sent %', 'Peak Hour']],
    body: channelBody,
    theme: 'striped',
    headStyles: { fillColor: tealColor, font: 'helvetica', fontStyle: 'bold', fontSize: 9 },
    bodyStyles: { fontSize: 9 },
  })

  addPageFooter(2)

  // ──────────────────── PAGE 3: Category Breakdown ────────────────────
  doc.addPage()
  addPageHeader('Category Breakdown')

  y = 24
  doc.setFont('helvetica', 'bold')
  doc.setFontSize(16)
  doc.setTextColor(...darkColor)
  doc.text('Top Categories', margin, y)
  y += 4

  doc.setFont('helvetica', 'normal')
  doc.setFontSize(9)
  doc.setTextColor(...grayColor)
  doc.text('Classification categories ranked by volume (top 10)', margin, y + 5)
  y += 14

  const top10 = data.categoryBreakdown.slice(0, 10)
  const catBody = top10.map((cat) => {
    const pct = totalCat > 0 ? ((cat.count / totalCat) * 100).toFixed(1) : '0'
    return [cat.name, String(cat.count), `${pct}%`]
  })

  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head: [['Category', 'Count', '% of Total']],
    body: catBody.length > 0 ? catBody : [['No classifications found', '-', '-']],
    theme: 'striped',
    headStyles: { fillColor: tealColor, font: 'helvetica', fontStyle: 'bold', fontSize: 10 },
    bodyStyles: { fontSize: 10 },
    columnStyles: { 0: { cellWidth: 80 } },
  })

  // Also add urgency distribution
  const lastTableY = (doc as any).lastAutoTable?.finalY || y + 40
  y = lastTableY + 16

  doc.setFont('helvetica', 'bold')
  doc.setFontSize(14)
  doc.setTextColor(...darkColor)
  doc.text('Urgency Distribution', margin, y)
  y += 8

  const totalUrg = data.urgencyDistribution.reduce((s, u) => s + u.count, 0)
  const urgBody = data.urgencyDistribution.map((u) => {
    const pct = totalUrg > 0 ? ((u.count / totalUrg) * 100).toFixed(1) : '0'
    return [u.level, String(u.count), `${pct}%`]
  })

  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head: [['Urgency Level', 'Count', '% of Total']],
    body: urgBody.length > 0 ? urgBody : [['No data', '-', '-']],
    theme: 'striped',
    headStyles: { fillColor: tealColor, font: 'helvetica', fontStyle: 'bold', fontSize: 10 },
    bodyStyles: { fontSize: 10 },
  })

  addPageFooter(3)

  // ──────────────────── PAGE 4: AI Performance ────────────────────
  if (data.aiMetrics) {
    doc.addPage()
    addPageHeader('AI Performance')

    y = 24
    doc.setFont('helvetica', 'bold')
    doc.setFontSize(16)
    doc.setTextColor(...darkColor)
    doc.text('AI Performance Metrics', margin, y)
    y += 4

    doc.setFont('helvetica', 'normal')
    doc.setFontSize(9)
    doc.setTextColor(...grayColor)
    doc.text('Automated classification and reply generation statistics', margin, y + 5)
    y += 14

    autoTable(doc, {
      startY: y,
      margin: { left: margin, right: margin },
      head: [['Metric', 'Value']],
      body: [
        ['Total AI Replies Generated', String(data.aiMetrics.totalRepliesGenerated)],
        ['Approval Rate', `${data.aiMetrics.approvalRate}%`],
        ['Average Confidence Score', `${data.aiMetrics.classificationAccuracy}%`],
        ['Auto-Send Rate', `${data.aiMetrics.autoSendRate}%`],
        ['Edit Rate', `${data.aiMetrics.editRate}%`],
        ['Total Classifications', String(data.aiMetrics.totalClassifications)],
      ],
      theme: 'striped',
      headStyles: { fillColor: tealColor, font: 'helvetica', fontStyle: 'bold', fontSize: 10 },
      bodyStyles: { fontSize: 10 },
      columnStyles: { 0: { fontStyle: 'bold', cellWidth: 80 } },
    })

    addPageFooter(4)
  }

  // ──────────────────── Save ────────────────────
  const periodLabel = data.dateRange === 'custom' ? 'custom' : data.dateRange
  const dateStr = new Date().toISOString().split('T')[0]
  doc.save(`report-${dateStr}-${periodLabel}.pdf`)
}
