const PDFDocument = require("pdfkit");
// const { generateInvoicePDF } = require("../utils/pdfGenerator");

function generateInvoicePDF(invoice, items = []) {
  const doc = new PDFDocument({
    size: "A4",
    margin: 40,
  });

  // Header
  doc
    .fontSize(22)
    .text(invoice.firm_name || "TaxPro GST", { align: "center" });

  doc
    .fontSize(10)
    .text(invoice.firm_address || "", { align: "center" })
    .text(`GSTIN: ${invoice.firm_gstin || ""}`, { align: "center" });

  doc.moveDown();
  doc.fontSize(18).text("TAX INVOICE", { align: "center" });
  doc.moveDown();

  // Invoice details
  doc.fontSize(10);
  doc.text(`Invoice No: ${invoice.invoice_no || ""}`);
  doc.text(`Invoice Date: ${invoice.invoice_date || ""}`);
  doc.text(`Party Name: ${invoice.party_name || ""}`);
  doc.text(`Party GSTIN: ${invoice.party_gstin || ""}`);
  doc.moveDown();

  // Table header
  doc.fontSize(10).text(
    "--------------------------------------------------------------------------"
  );
  doc.text("Item                    Qty      Rate      GST%      Amount");
  doc.text(
    "--------------------------------------------------------------------------"
  );

  // Items
  items.forEach((item) => {
    doc.text(
      `${(item.name || "").padEnd(20).substring(0, 20)} ` +
        `${String(item.qty || 0).padStart(5)} ` +
        `${String(item.rate || 0).padStart(10)} ` +
        `${String(item.gst_rate || 0).padStart(8)} ` +
        `${String(item.total_amount || 0).padStart(10)}`
    );
  });

  doc.text(
    "--------------------------------------------------------------------------"
  );
  doc.moveDown();

  // Totals
  doc.text(`Taxable Amount: ₹ ${invoice.taxable_amount || 0}`);
  doc.text(`Total Tax: ₹ ${invoice.total_tax || 0}`);
  doc.fontSize(12).text(`Grand Total: ₹ ${invoice.total_amount || 0}`, {
    align: "right",
  });

  doc.moveDown(2);

  // Footer
  doc.fontSize(10).text("Thank you for your business.", {
    align: "center",
  });

  doc.moveDown();
  doc.text("Authorized Signatory", {
    align: "right",
  });

  return doc;
}

module.exports = {
  generateInvoicePDF,
};