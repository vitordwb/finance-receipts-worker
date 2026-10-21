import { runInThisContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import scriptSource from '../apps-script/Code.gs?raw';

// The Workers Vitest pool provides runInThisContext through its unsafe-eval
// binding. Inject Apps Script services instead of using unsupported VM contexts.
const loadScript = runInThisContext(`(function (SpreadsheetApp, PropertiesService, ContentService, Date) {
${scriptSource}
return { doGet, doPost };
})`, { filename: 'apps-script/Code.gs' });

function scriptHarness({ dates = ['', '', ''], secret = 'test-append-secret', maxRows = dates.length + 7 } = {}) {
	const cells = new Map();
	const notes = new Map();
	const writes = [];
	const validations = [[null, null, null, { category: true }, { payment: true }, null]];
	const cellKey = (row, column) => `${row}:${column}`;
	dates.forEach((date, index) => cells.set(cellKey(index + 8, 2), date));

	const sheet = {
		getMaxRows: vi.fn(() => maxRows),
		insertRowsAfter: vi.fn((row, count) => {
			writes.push({ type: 'insert', row, count });
			maxRows += count;
		}),
		getRange: vi.fn((row, column, rows = 1, columns = 1) => ({
			row, column, rows, columns,
			getDisplayValues() {
				return Array.from({ length: rows }, (_, rowOffset) =>
					Array.from({ length: columns }, (_, columnOffset) => String(cells.get(cellKey(row + rowOffset, column + columnOffset)) ?? ''))
				);
			},
			copyTo(target, type, transpose) {
				writes.push({ type: 'copy', row, column, rows, columns, targetRow: target.row, targetColumn: target.column, paste: type, transpose });
			},
			getDataValidations() {
				return validations;
			},
			setDataValidations(value) {
				writes.push({ type: 'validation', row, column, rows, columns, value });
			},
			setValues(values) {
				writes.push({ type: 'values', row, column, rows, columns, values });
				values.forEach((valuesRow, rowOffset) => valuesRow.forEach((value, columnOffset) => {
					cells.set(cellKey(row + rowOffset, column + columnOffset), value);
				}));
			},
			setNote(value) {
				writes.push({ type: 'note', row, column, value });
				notes.set(cellKey(row, column), value);
			},
			setNumberFormat(value) {
				writes.push({ type: 'format', row, column, value });
			}
		}))
	};
	const spreadsheet = { getSheetByName: vi.fn(() => sheet) };
	const spreadsheetApp = {
		openById: vi.fn(() => spreadsheet),
		CopyPasteType: { PASTE_FORMAT: 'PASTE_FORMAT' }
	};
	const properties = { getProperty: vi.fn(() => secret) };
	const contentService = {
		MimeType: { JSON: 'application/json' },
		createTextOutput: text => ({
			text,
			setMimeType(mimeType) {
				this.mimeType = mimeType;
				return this;
			}
		})
	};
	// A local-time Date construction would fail, regardless of the machine's TZ.
	class UtcOnlyDate {
		constructor() {
			throw new Error('Date serials must not construct local-time dates.');
		}
		static UTC = vi.fn((...args) => Date.UTC(...args));
	}
	const script = loadScript(spreadsheetApp, { getScriptProperties: () => properties }, contentService, UtcOnlyDate);
	const payload = {
		secret: 'test-append-secret',
		date: '2026-06-03',
		merchant: 'Test Store',
		amount: 12.34,
		category: 'Groceries',
		payment_method: 'CREDIT_CARD',
		notes: 'Bread and milk',
		image_url: 'https://receipts.example.test/receipts/2026-06-03/test.jpg'
	};

	return {
		...script,
		post: (overrides = {}) => JSON.parse(script.doPost({ postData: { contents: JSON.stringify({ ...payload, ...overrides }) } }).text),
		cells, notes, writes, sheet, spreadsheet, spreadsheetApp, properties, validations, UtcOnlyDate
	};
}

function expectNoSpreadsheetAccess(harness) {
	expect(harness.spreadsheetApp.openById).not.toHaveBeenCalled();
	expect(harness.writes).toEqual([]);
}

describe('Apps Script spreadsheet receiver', () => {
	it('exposes a JSON health response without opening the spreadsheet', () => {
		const harness = scriptHarness();
		const response = harness.doGet();
		expect(response.mimeType).toBe('application/json');
		expect(JSON.parse(response.text)).toEqual({ ok: true, service: 'finance-sheet-append' });
		expectNoSpreadsheetAccess(harness);
	});

	it('writes B:G into the first empty B row, inheriting only format and validation', () => {
		const harness = scriptHarness({ dates: [46175, '', 46177] });
		const result = harness.post();

		expect(result).toEqual({
			ok: true,
			row: 9,
			written: {
				date: '2026-06-03', merchant: 'Test Store', amount: 12.34, category: 'Groceries',
				payment_method: 'CREDIT_CARD', notes: 'Bread and milk',
				image_url: 'https://receipts.example.test/receipts/2026-06-03/test.jpg'
			}
		});
		expect(harness.spreadsheetApp.openById).toHaveBeenCalledWith('1nG0ho2q2lzBFkJeAbH8n29WJ3Ib4CrXpb01-gEuhdCE');
		expect(harness.spreadsheet.getSheetByName).toHaveBeenCalledWith('Expenses');
		expect(harness.properties.getProperty).toHaveBeenCalledWith('APPEND_SECRET');
		expect(harness.writes).toEqual([
			{ type: 'copy', row: 8, column: 2, rows: 1, columns: 6, targetRow: 9, targetColumn: 2, paste: 'PASTE_FORMAT', transpose: false },
			{ type: 'validation', row: 9, column: 2, rows: 1, columns: 6, value: harness.validations },
			{ type: 'values', row: 9, column: 2, rows: 1, columns: 6, values: [[46176, 'Test Store', 12.34, 'Groceries', 'CREDIT_CARD', 'Bread and milk']] },
			{ type: 'note', row: 9, column: 4, value: result.written.image_url },
			{ type: 'format', row: 9, column: 2, value: 'MM-dd-yyyy' }
		]);
		expect(harness.cells.get('8:2')).toBe(46175);
		expect(harness.cells.get('10:2')).toBe(46177);
		expect(harness.cells.has('9:1')).toBe(false);
		expect(harness.cells.has('9:8')).toBe(false);
	});

	it('preserves the first data row template rather than copying the header row', () => {
		const harness = scriptHarness();
		expect(harness.post().row).toBe(8);
		expect(harness.writes.some(write => write.type === 'copy' || write.type === 'validation')).toBe(false);
	});

	it('clears an old Amount note when the new URL is blank', () => {
		const harness = scriptHarness();
		harness.notes.set('8:4', 'https://old.example.test/receipt.jpg');
		const result = harness.post({ image_url: '', payment_method: '', notes: '' });
		expect(result.ok).toBe(true);
		expect(harness.notes.get('8:4')).toBe('');
		expect(harness.cells.get('8:6')).toBe('');
		expect(harness.cells.get('8:7')).toBe('');
	});

	it('inserts a row after the sheet is full and treats serial zero as occupied', () => {
		const harness = scriptHarness({ dates: [0, 46175] });
		expect(harness.post().row).toBe(10);
		expect(harness.sheet.insertRowsAfter).toHaveBeenCalledWith(9, 1);
		expect(harness.writes[1]).toMatchObject({ type: 'copy', row: 9, targetRow: 10 });
	});

	it('extends a short sheet through the configured starting row', () => {
		const harness = scriptHarness({ dates: [], maxRows: 5 });
		expect(harness.post().row).toBe(8);
		expect(harness.sheet.insertRowsAfter).toHaveBeenCalledWith(5, 3);
	});

	it.each([
		['1899-12-30', 0],
		['1970-01-01', 25569],
		['2026-03-08', 46089],
		['2026-06-03', 46176],
		['2026-11-01', 46327]
	])('uses a timezone-independent UTC serial for %s', (date, serial) => {
		const harness = scriptHarness();
		expect(harness.post({ date }).ok).toBe(true);
		expect(harness.cells.get('8:2')).toBe(serial);
	});

	it('normalizes currency, whitespace, unknown categories, and payment labels', () => {
		const harness = scriptHarness();
		expect(harness.post({
			date: ' 2026-06-03 ', merchant: ' Shop ', amount: '¥ 1,234.50', category: 'unlisted',
			payment_method: ' cash ', notes: ' Tea and bread ', image_url: ' http://receipts.example.test/a.jpg '
		}).written).toEqual({
			date: '2026-06-03', merchant: 'Shop', amount: 1234.5, category: 'Other',
			payment_method: 'CASH', notes: 'Tea and bread', image_url: 'http://receipts.example.test/a.jpg'
		});
	});

	it.each(['CREDIT_CARD', 'CASH', '', 'DEBIT', 'credit', 'UNKNOWN', null])('normalizes payment_method %s', paymentMethod => {
		const harness = scriptHarness();
		const expected = ['CREDIT_CARD', 'CASH'].includes(paymentMethod) ? paymentMethod : '';
		expect(harness.post({ payment_method: paymentMethod }).written.payment_method).toBe(expected);
		expect(harness.cells.get('8:6')).toBe(expected);
	});

	it.each(['=', '+', '-', '@'])('escapes a leading %s in merchant and notes, not the receipt URL', prefix => {
		const harness = scriptHarness();
		const result = harness.post({ merchant: ` ${prefix}merchant`, notes: ` ${prefix}items`, image_url: 'https://receipts.example.test/@a?x=+1' });
		expect(result.written.merchant).toBe(`'${prefix}merchant`);
		expect(result.written.notes).toBe(`'${prefix}items`);
		expect(harness.notes.get('8:4')).toBe('https://receipts.example.test/@a?x=+1');
	});

	it('defaults missing optional fields and an empty merchant', () => {
		const harness = scriptHarness();
		const result = harness.post({ merchant: ' ', payment_method: undefined, notes: undefined, image_url: undefined });
		expect(result.written).toMatchObject({ merchant: 'Unknown', payment_method: '', notes: '', image_url: '' });
	});

	it('treats a whitespace-only displayed date as empty and trims valid categories', () => {
		const harness = scriptHarness({ dates: [46175, '   ', 46177] });
		const result = harness.post({ category: ' Groceries ' });
		expect(result.row).toBe(9);
		expect(result.written.category).toBe('Groceries');
	});

	it.each([
		{ date: '06/03/2026' }, { date: '2026-6-03' }, { date: '' },
		{ amount: 0 }, { amount: -5 }, { amount: null }, { amount: 'not a number' }, { amount: '1.2.3' },
		{ image_url: '/receipt.jpg' }, { image_url: 'javascript:alert(1)' }, { image_url: 'ftp://receipts.example.test/a' },
		{ image_url: 'https://' }, { image_url: 'https://receipts.example.test/a b' }
	])('rejects invalid fields without opening or writing the spreadsheet: %j', overrides => {
		const harness = scriptHarness();
		expect(harness.post(overrides)).toMatchObject({ ok: false, error: expect.any(String) });
		expectNoSpreadsheetAccess(harness);
	});

	it.each(['wrong-secret', '', undefined])('rejects an invalid secret without spreadsheet access', secret => {
		const harness = scriptHarness();
		expect(harness.post({ secret, amount: -1 }).ok).toBe(false);
		expectNoSpreadsheetAccess(harness);
	});

	it('requires manual APPEND_SECRET configuration without writing', () => {
		const harness = scriptHarness({ secret: null });
		expect(harness.post().ok).toBe(false);
		expectNoSpreadsheetAccess(harness);
	});

	it.each(['{', 'null', '[]', '"text"'])('rejects malformed or non-object JSON without writing: %s', contents => {
		const harness = scriptHarness();
		expect(JSON.parse(harness.doPost({ postData: { contents } }).text).ok).toBe(false);
		expectNoSpreadsheetAccess(harness);
	});

	it('reports a missing sheet without mutating anything', () => {
		const harness = scriptHarness();
		harness.spreadsheet.getSheetByName.mockReturnValue(null);
		expect(harness.post().ok).toBe(false);
		expect(harness.writes).toEqual([]);
	});
});
