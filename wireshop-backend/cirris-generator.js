// Build a Cirris Easy-Wire text program directly from the standard Cirris setup workbook.
// No spreadsheet npm dependency is required: XLSX is parsed as a small ZIP/XML package using Node built-ins.

const path = require('path');
const zlib = require('zlib');

function unzipEntries(buffer) {
  const EOCD = 0x06054b50;
  const CEN = 0x02014b50;
  const LOC = 0x04034b50;

  let eocd = -1;
  const min = Math.max(0, buffer.length - 0xffff - 22);
  for (let i = buffer.length - 22; i >= min; i--) {
    if (buffer.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Invalid XLSX file: ZIP end record not found');

  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  let p = centralOffset;

  for (let i = 0; i < totalEntries; i++) {
    if (buffer.readUInt32LE(p) !== CEN) {
      throw new Error('Invalid XLSX file: ZIP central directory is damaged');
    }

    const method = buffer.readUInt16LE(p + 10);
    const compressedSize = buffer.readUInt32LE(p + 20);
    const fileNameLength = buffer.readUInt16LE(p + 28);
    const extraLength = buffer.readUInt16LE(p + 30);
    const commentLength = buffer.readUInt16LE(p + 32);
    const localOffset = buffer.readUInt32LE(p + 42);
    const name = buffer
      .toString('utf8', p + 46, p + 46 + fileNameLength)
      .replace(/\\/g, '/');

    if (buffer.readUInt32LE(localOffset) !== LOC) {
      throw new Error(`Invalid XLSX file: ZIP entry ${name} is damaged`);
    }

    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);

    let data;
    if (method === 0) data = Buffer.from(compressed);
    else if (method === 8) data = zlib.inflateRawSync(compressed);
    else throw new Error(`Unsupported XLSX compression method ${method}`);

    entries.set(name, data);
    p += 46 + fileNameLength + extraLength + commentLength;
  }

  return entries;
}

function decodeXml(value) {
  return String(value ?? '')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function getAttr(attrs, name) {
  const escaped = name.replace(':', '\\:');
  const match = String(attrs || '').match(new RegExp(`(?:^|\\s)${escaped}="([^"]*)"`));
  return match ? decodeXml(match[1]) : null;
}

function colIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  const re = /<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>/g;
  let match;

  while ((match = re.exec(xml))) {
    let text = '';
    const textRe = /<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g;
    let textMatch;
    while ((textMatch = textRe.exec(match[1]))) text += decodeXml(textMatch[1]);
    out.push(text);
  }

  return out;
}

function parseSheet(xml, sharedStrings) {
  const rows = [];
  const cellRe = /<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g;
  let match;

  while ((match = cellRe.exec(xml))) {
    const attrs = match[1] || '';
    const body = match[2] || '';
    const ref = getAttr(attrs, 'r');
    if (!ref) continue;

    const refMatch = ref.match(/^([A-Z]+)(\d+)$/i);
    if (!refMatch) continue;

    const col = colIndex(refMatch[1].toUpperCase());
    const row = Number(refMatch[2]) - 1;
    while (rows.length <= row) rows.push([]);

    const type = getAttr(attrs, 't');
    const valueMatch = body.match(/<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/);
    let value = null;

    if (type === 's') {
      const idx = valueMatch ? Number(valueMatch[1]) : NaN;
      value = Number.isFinite(idx) ? (sharedStrings[idx] ?? '') : '';
    } else if (type === 'inlineStr') {
      let text = '';
      const textRe = /<(?:\w+:)?t\b[^>]*>([\s\S]*?)<\/(?:\w+:)?t>/g;
      let textMatch;
      while ((textMatch = textRe.exec(body))) text += decodeXml(textMatch[1]);
      value = text;
    } else if (type === 'str') {
      value = valueMatch ? decodeXml(valueMatch[1]) : '';
    } else if (type === 'b') {
      value = valueMatch ? valueMatch[1] === '1' : false;
    } else if (valueMatch) {
      const raw = decodeXml(valueMatch[1]);
      const numeric = Number(raw);
      value = raw !== '' && Number.isFinite(numeric) ? numeric : raw;
    }

    rows[row][col] = value;
  }

  return rows;
}

function parseWorkbook(buffer) {
  const entries = unzipEntries(buffer);
  const workbookXml = entries.get('xl/workbook.xml')?.toString('utf8');
  const relsXml = entries.get('xl/_rels/workbook.xml.rels')?.toString('utf8');

  if (!workbookXml || !relsXml) {
    throw new Error('Invalid XLSX file: workbook metadata is missing');
  }

  const relationships = new Map();
  for (const match of relsXml.matchAll(/<Relationship\b([^>]*?)\/>/g)) {
    const id = getAttr(match[1], 'Id');
    const target = getAttr(match[1], 'Target');
    if (id && target) relationships.set(id, target);
  }

  const sharedStrings = parseSharedStrings(
    entries.get('xl/sharedStrings.xml')?.toString('utf8') || ''
  );

  const sheets = new Map();
  for (const match of workbookXml.matchAll(/<(?:\w+:)?sheet\b([^>]*?)\/>/g)) {
    const name = getAttr(match[1], 'name');
    const relationshipId = getAttr(match[1], 'r:id');
    const target = relationships.get(relationshipId);
    if (!name || !target) continue;

    const fullPath = target.startsWith('/')
      ? target.slice(1)
      : path.posix.normalize(path.posix.join('xl', target));

    const xml = entries.get(fullPath)?.toString('utf8');
    if (!xml) throw new Error(`Invalid XLSX file: worksheet ${name} is missing`);
    sheets.set(name, parseSheet(xml, sharedStrings));
  }

  return sheets;
}

function norm(value) {
  return String(value ?? '').trim();
}

function headerMap(row) {
  const map = new Map();
  (row || []).forEach((value, index) => {
    const key = norm(value).toUpperCase();
    if (key) map.set(key, index);
  });
  return map;
}

function requiredCol(map, name, sheetName) {
  const index = map.get(name.toUpperCase());
  if (index == null) {
    throw new Error(`${sheetName} sheet is missing required column "${name}"`);
  }
  return index;
}

function buildGraphicType(partNumber, pinCount) {
  const pins = [];
  for (let pin = 1; pin <= pinCount; pin++) {
    pins.push(`${pin}, -1, -20000, -20000, PIN_GROUP, 0`);
  }

  return [
    `     ${partNumber} , ${pinCount}, ${pins.join(', ')}, STYLE, Standard, , 0, 2, 1`,
    '    GraphicView, 1',
    '    Strapping, 0, 0, 0, 0, 0, 0, 0, 0, 0',
  ].join('\n');
}

function validationError(details) {
  const error = new Error('Cirris form validation failed');
  error.details = details;
  return error;
}

function generateCirrisProgram(buffer) {
  const sheets = parseWorkbook(buffer);
  const testRows = sheets.get('Test');
  const connectorRows = sheets.get('Connectors');

  if (!testRows) throw new Error('Workbook is missing the Test sheet');
  if (!connectorRows) throw new Error('Workbook is missing the Connectors sheet');
  if (!testRows.length) throw new Error('Test sheet is empty');
  if (!connectorRows.length) throw new Error('Connectors sheet is empty');

  const testHeaders = headerMap(testRows[0]);
  const connectorHeaders = headerMap(connectorRows[0]);

  const tRef = requiredCol(testHeaders, 'Harness_Connector', 'Test');
  const tHarnessPin = requiredCol(testHeaders, 'Harness_Pin', 'Test');
  const tGlobal = requiredCol(testHeaders, 'Global_Point_No', 'Test');
  const tTablePin = requiredCol(testHeaders, 'Pin', 'Test');
  const tUnit = requiredCol(testHeaders, 'Unit', 'Test');
  const tPort = requiredCol(testHeaders, 'Port', 'Test');

  const cRef = requiredCol(connectorHeaders, 'CONNECTOR REF', 'Connectors');
  const cPart = requiredCol(connectorHeaders, 'PART NUMBER', 'Connectors');
  const cPinCount = requiredCol(connectorHeaders, 'PIN COUNT', 'Connectors');

  const connectors = [];
  const byRef = new Map();
  const errors = [];

  for (let i = 1; i < connectorRows.length; i++) {
    const row = connectorRows[i] || [];
    const ref = norm(row[cRef]);
    const partNumber = norm(row[cPart]);
    const rawPinCount = row[cPinCount];

    if (!ref && !partNumber && (rawPinCount == null || rawPinCount === '')) continue;

    if (!ref || !partNumber) {
      errors.push(`Connectors row ${i + 1}: connector reference and part number are required.`);
      continue;
    }

    const pinCount = Number(rawPinCount);
    if (!Number.isInteger(pinCount) || pinCount <= 0) {
      errors.push(`Connectors row ${i + 1} (${ref}): PIN COUNT must be a positive whole number.`);
      continue;
    }

    const key = ref.toUpperCase();
    if (byRef.has(key)) {
      errors.push(`Connectors sheet defines ${ref} more than once.`);
      continue;
    }

    const connector = {
      ref,
      partNumber,
      pinCount,
      attach: Array(pinCount).fill(-1),
      mappedRows: [],
    };

    connectors.push(connector);
    byRef.set(key, connector);
  }

  if (!connectors.length) errors.push('Connectors sheet has no connector definitions.');

  const pointOwner = new Map();
  let mappedRowCount = 0;

  for (let i = 1; i < testRows.length; i++) {
    const row = testRows[i] || [];
    const ref = norm(row[tRef]);
    if (!ref) continue;

    mappedRowCount++;
    const harnessPin = Number(row[tHarnessPin]);
    const globalPoint = Number(row[tGlobal]);
    const tablePin = Number(row[tTablePin]);
    const unit = norm(row[tUnit]);
    const port = norm(row[tPort]);
    const connector = byRef.get(ref.toUpperCase());

    if (!connector) {
      errors.push(`Test row ${i + 1}: connector ${ref} is not defined on the Connectors sheet.`);
      continue;
    }

    if (!Number.isInteger(harnessPin) || harnessPin < 1 || harnessPin > connector.pinCount) {
      errors.push(
        `Test row ${i + 1} (${ref}): Harness_Pin ${row[tHarnessPin]} is outside 1-${connector.pinCount}.`
      );
      continue;
    }

    if (!Number.isInteger(globalPoint) || globalPoint < 1) {
      errors.push(
        `Test row ${i + 1} (${ref}:${harnessPin}): Global_Point_No must be a positive whole number.`
      );
      continue;
    }

    if (!Number.isInteger(tablePin) || tablePin < 1 || tablePin > 64) {
      errors.push(`Test row ${i + 1} (${ref}:${harnessPin}): Pin must be 1-64.`);
      continue;
    }

    const previousPoint = connector.attach[harnessPin - 1];
    if (previousPoint !== -1 && previousPoint !== globalPoint) {
      errors.push(
        `${ref}:${harnessPin} maps to both tester point ${previousPoint} and ${globalPoint}.`
      );
      continue;
    }

    const endpoint = `${connector.ref}:${harnessPin}`;
    const existingOwner = pointOwner.get(globalPoint);
    if (existingOwner && existingOwner !== endpoint) {
      errors.push(
        `Tester point ${globalPoint} is assigned to both ${existingOwner} and ${endpoint}.`
      );
      continue;
    }

    connector.attach[harnessPin - 1] = globalPoint;
    pointOwner.set(globalPoint, endpoint);
    connector.mappedRows.push({
      harnessPin,
      globalPoint,
      tablePin,
      unit,
      port,
    });
  }

  if (!mappedRowCount) errors.push('Test sheet has no mapped connector rows.');

  // The standard workbook records only used harness endpoints. For direct/reusable 1:1
  // adapters (IP6/IP7/S1-style mappings), attach every physical connector cavity so
  // Easy-Wire can also catch shorts/miswires into currently unused cavities.
  // A connector qualifies only when every mapped row is on one Unit/Port and
  // Harness_Pin == table Pin with a consistent system-point offset.
  for (const connector of connectors) {
    if (connector.mappedRows.length < 2) continue;

    const first = connector.mappedRows[0];
    const offset = first.globalPoint - first.tablePin;
    const oneToOne = connector.mappedRows.every((row) =>
      row.unit === first.unit &&
      row.port === first.port &&
      row.harnessPin === row.tablePin &&
      row.globalPoint - row.tablePin === offset
    );

    if (!oneToOne) continue;

    for (let pin = 1; pin <= connector.pinCount; pin++) {
      const point = offset + pin;
      const endpoint = `${connector.ref}:${pin}`;
      const existingOwner = pointOwner.get(point);

      if (existingOwner && existingOwner !== endpoint) {
        errors.push(
          `Cannot complete 1:1 mapping for ${connector.ref}: tester point ${point} is already assigned to ${existingOwner}.`
        );
        continue;
      }

      connector.attach[pin - 1] = point;
      pointOwner.set(point, endpoint);
    }
  }

  if (errors.length) throw validationError(errors);

  // A connector part number only needs one GRAPHIC_CONN_TYPES definition even when
  // that connector type appears more than once in the harness (BP6/BP24, for example).
  const uniqueTypes = [];
  const typeByPart = new Map();

  for (const connector of connectors) {
    const key = connector.partNumber.toUpperCase();
    const prior = typeByPart.get(key);

    if (prior) {
      if (prior.pinCount !== connector.pinCount) {
        throw validationError([
          `Part number ${connector.partNumber} is listed with conflicting pin counts (${prior.pinCount} and ${connector.pinCount}).`,
        ]);
      }
    } else {
      typeByPart.set(key, connector);
      uniqueTypes.push(connector);
    }
  }

  const attachedPoints = connectors.flatMap((connector) =>
    connector.attach.filter((value) => value !== -1)
  );
  const attachedCount = attachedPoints.length;
  const highestPoint = attachedPoints.length ? Math.max(...attachedPoints) : 0;

  const defaults = `TESTDEFAULTS
BEGIN
    TESTER , 8100, 256, AHED-64
    STARTEVENT , BUTTON
    SERIALENTRY , NONE
    TESTTYPE , BUILD
    SHOWCONNECTORS , On
    ERRORDETAILS , On
    MEASUREDVALUES , Off
    SHOWCURRENTINSTRUCTION , On
    SOUND , On
    DEBUG , Off
    ERRORLOCATION , Off, 10
    USECOMPONENTRES , On
    USELOTID , Off
    FAVENABLED , Off
    FIRSTARTICLEVERIFIED , Off
    ASSOCIATEDFILE , 
    HVIRVALUES , Off
    USELABELS , Off
    USESSMARTLIGHTS , Off
    COMMONHARDWARE_4W_PATTERN_OFFSET , 32
END`;

  const graphics = `GRAPHIC_CONN_TYPES
BEGIN
${uniqueTypes.map((connector) => buildGraphicType(connector.partNumber, connector.pinCount)).join('\n')}
END`;

  const interfacing = `INTERFACING
BEGIN
${connectors.map((connector) => `     ${connector.ref} ,  ${connector.partNumber} `).join('\n')}
END`;

  const attach = `ATTACH
BEGIN
${connectors.map((connector) => `     ${connector.ref} , ${connector.attach.join(', ')}`).join('\n')}
END`;

  const parameters = `PARAMETERS
BEGIN
    WIRERES , 5.0 Ohm
    RESISTORRES , 100 Ohm
    RESISTORTOL ,  10 %
    FORWARDV , 700 mV
    REVERSEV , > 6.00 V
    FORWARDTOL ,  20 %
    REVERSETOL ,  20 %
    SHORTSRES , 500 kOhm
    CAPTOLERANCE ,  20 %
    WIRERESTARE , 0.0 Ohm
    DELAYRESISTANCERES , 0.1 Ohm
    DELAYRESISTANCETOL ,  1 %
    COMMENTDELAY , 5.00 s
    4W_WIRERES , 1.00 Ohm
    4W_WIRERESTARE , 0 mOhm
    4W_WIREMIN , 0 mOhm
    4W_RESISTORRES , 10.0 Ohm
    4W_RESISTORTOL ,  1 %
    COMPONENT_RESISTANCE , 0 Ohm
    INDUCTANCE , 1.00 uH
    INDUCTANCE_TOL ,  10 %
    PIN_CAPACITANCE , 5.0 pF
    PROBE_R_MIN , 0.0 Ohm
    PROBE_R_MAX , 5.0 Ohm
    CAPACITANCE , 1.00 nF
END`;

  const labels = `CUSTOM_LABELS
BEGIN
END`;

  return {
    text: [defaults, graphics, interfacing, attach, parameters, labels].join('\n\n') + '\n',
    connectorCount: connectors.length,
    attachedCount,
    highestPoint,
  };
}

module.exports = {
  generateCirrisProgram,
};
