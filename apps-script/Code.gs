// Copy into a Google Apps Script project using the V8 runtime.
// In Project Settings > Script Properties, manually set APPEND_SECRET to a new
// secret matching the Worker's GOOGLE_SCRIPT_SECRET. Never put it in this file.
// Deploy as a web app executing as the spreadsheet owner, accessible to anyone.
// Existing rows are not migrated. New rows use B:G below; D holds the receipt URL
// as a cell note, not a formula. Row 8 should already have the desired template.
const CONFIG = {
	SPREADSHEET_ID: '1nG0ho2q2lzBFkJeAbH8n29WJ3Ib4CrXpb01-gEuhdCE',
	SHEET_NAME: 'Expenses',
	START_ROW: 8
};

// Keep aligned with CATEGORIES in src/index.js.
const CATEGORIES = [
	'Car maintenance', 'Car payment', 'Pension', 'Clothing', 'Education', 'Debt',
	'Electronics', 'Entertainment', 'Gas', 'Gifts', 'Going out', 'Groceries', 'Gym',
	'Home maintenance', 'Insurance', 'Medical', 'Mortgage', 'Other',
	'Public transportation', 'Rent', 'Restaurant', 'Telecom', 'Travel', 'Utilities', 'Work'
];

function doGet() {
	return jsonResponse({ ok: true, service: 'finance-sheet-append' });
}

function doPost(e) {
	try {
		const payload = JSON.parse(e && e.postData ? e.postData.contents : '');
		const secret = PropertiesService.getScriptProperties().getProperty('APPEND_SECRET');
		if (!secret) {
			throw new Error('Configure APPEND_SECRET in Project Settings > Script Properties.');
		}
		if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.secret !== secret) {
			throw new Error('Unauthorized.');
		}

		const expense = normalizeExpense(payload);
		const spreadsheet = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
		const sheet = CONFIG.SHEET_NAME ? spreadsheet.getSheetByName(CONFIG.SHEET_NAME) : spreadsheet.getSheets()[0];
		if (!sheet) {
			throw new Error('Sheet not found: ' + CONFIG.SHEET_NAME);
		}

		const row = firstEmptyRow(sheet);
		const target = sheet.getRange(row, 2, 1, 6);
		if (row > CONFIG.START_ROW) {
			const previous = sheet.getRange(row - 1, 2, 1, 6);
			previous.copyTo(target, SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
			target.setDataValidations(previous.getDataValidations());
		}
		target.setValues([[
			dateSerial(expense.date), expense.merchant, expense.amount,
			expense.category, expense.payment_method, expense.notes
		]]);
		// Always set the note: an empty URL clears any stale note in a reused row.
		sheet.getRange(row, 4).setNote(expense.image_url);
		sheet.getRange(row, 2).setNumberFormat('MM-dd-yyyy');

		return jsonResponse({ ok: true, row: row, written: expense });
	} catch (error) {
		return jsonResponse({ ok: false, error: error.message });
	}
}

function normalizeExpense(payload) {
	const date = String(payload.date || '').trim();
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
		throw new Error('Date must use YYYY-MM-DD.');
	}

	const amount = typeof payload.amount === 'number'
		? payload.amount
		: Number(String(payload.amount == null ? '' : payload.amount).replace(/,/g, '').replace(/[^0-9.\-]/g, ''));
	if (!Number.isFinite(amount) || amount <= 0) {
		throw new Error('Amount must be a positive number.');
	}

	const paymentMethod = String(payload.payment_method || '').trim().toUpperCase();
	const category = String(payload.category || '').trim();
	const imageUrl = String(payload.image_url || '').trim();
	if (imageUrl && !/^https?:\/\/[^\s/?#]+(?:[/?#][^\s]*)?$/i.test(imageUrl)) {
		throw new Error('image_url must be an absolute http(s) URL or empty.');
	}

	return {
		date: date,
		merchant: cleanText(payload.merchant, 80) || 'Unknown',
		amount: amount,
		category: CATEGORIES.includes(category) ? category : 'Other',
		payment_method: paymentMethod === 'CREDIT_CARD' || paymentMethod === 'CASH' ? paymentMethod : '',
		notes: cleanText(payload.notes, 1000),
		image_url: imageUrl
	};
}
function cleanText(value, maxLength) {
	const text = String(value == null ? '' : value).trim();
	return (/^[=+\-@]/.test(text) ? "'" + text : text).slice(0, maxLength);
}

function dateSerial(date) {
	const parts = date.split('-').map(Number);
	return (Date.UTC(parts[0], parts[1] - 1, parts[2]) - Date.UTC(1899, 11, 30)) / 86400000;
}

function firstEmptyRow(sheet) {
	let maxRows = sheet.getMaxRows();
	if (maxRows < CONFIG.START_ROW) {
		sheet.insertRowsAfter(maxRows, CONFIG.START_ROW - maxRows);
		maxRows = CONFIG.START_ROW;
	}
	const dates = sheet.getRange(CONFIG.START_ROW, 2, maxRows - CONFIG.START_ROW + 1, 1).getDisplayValues();
	for (let index = 0; index < dates.length; index++) {
		if (dates[index][0].trim() === '') {
			return CONFIG.START_ROW + index;
		}
	}
	sheet.insertRowsAfter(maxRows, 1);
	return maxRows + 1;
}

function jsonResponse(value) {
	return ContentService.createTextOutput(JSON.stringify(value)).setMimeType(ContentService.MimeType.JSON);
}
