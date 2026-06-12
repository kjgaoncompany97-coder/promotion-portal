const SHEETS = {
  PROMOTIONS: '프로모션목록',
  ENTRIES: '참여등록',
  HISTORY: '검수이력',
  SETTLEMENT: '정산요약'
};

const STATUS = {
  RECEIVED: '접수',
  PENDING: '확인대기',
  APPROVED: '인정',
  REJECTED: '반려',
  DUPLICATE: '중복의심',
  ACTIVE: '진행중',
  ENDED: '종료'
};

const HEADERS = {
  [SHEETS.PROMOTIONS]: ['프로모션ID', '프로모션명', '설명', '이미지URL', '시작일', '종료일', '상태', '지급단가', '최대인정횟수'],
  [SHEETS.ENTRIES]: ['등록ID', '접수일시', '강사명', '팀', '프로모션ID', '프로모션명', '제출내용', '상태', '반려사유', '예상지급액'],
  [SHEETS.HISTORY]: ['검수일시', '등록ID', '관리자', '처리결과', '반려사유'],
  [SHEETS.SETTLEMENT]: ['강사명', '프로모션명', '인정건수', '예상지급액']
};

function doGet(e) {
  setupDatabase_();
  const page = e && e.parameter && e.parameter.page === 'admin' ? 'admin' : 'index';
  return HtmlService.createTemplateFromFile(page)
    .evaluate()
    .setTitle('프로모션 운영·검증 시스템')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function getInitialData() {
  setupDatabase_();
  return {
    promotions: listPromotions(),
    statuses: STATUS,
    today: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd')
  };
}

function listPromotions() {
  const rows = getRows_(SHEETS.PROMOTIONS);
  const now = startOfDay_(new Date()).getTime();
  return rows
    .filter(row => row['상태'] === STATUS.ACTIVE && now >= dateValue_(row['시작일']) && now <= dateValue_(row['종료일']))
    .slice(0, 5)
    .map(row => ({
      id: row['프로모션ID'],
      name: row['프로모션명'],
      description: row['설명'],
      imageUrl: row['이미지URL'],
      startDate: formatDate_(row['시작일']),
      endDate: formatDate_(row['종료일']),
      status: row['상태'],
      unitPrice: Number(row['지급단가']) || 0,
      maxCount: Number(row['최대인정횟수']) || 0
    }));
}

function registerParticipation(payload) {
  setupDatabase_();
  const data = sanitizePayload_(payload, ['teacherName', 'team', 'promotionId', 'submission']);
  if (!data.teacherName || !data.team || !data.promotionId || !data.submission) {
    throw new Error('강사명, 팀, 프로모션, 제출내용을 모두 입력해 주세요.');
  }

  const promotion = findPromotion_(data.promotionId);
  if (!promotion) throw new Error('진행 중인 프로모션을 찾을 수 없습니다.');

  const duplicate = getRows_(SHEETS.ENTRIES).some(row =>
    row['강사명'] === data.teacherName &&
    row['프로모션ID'] === data.promotionId &&
    row['제출내용'] === data.submission &&
    row['상태'] !== STATUS.REJECTED
  );

  const status = duplicate ? STATUS.DUPLICATE : STATUS.PENDING;
  const id = 'ENT-' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMddHHmmss') + '-' + Math.floor(Math.random() * 900 + 100);
  appendRow_(SHEETS.ENTRIES, [
    id,
    new Date(),
    data.teacherName,
    data.team,
    promotion['프로모션ID'],
    promotion['프로모션명'],
    data.submission,
    status,
    '',
    0
  ]);

  return { id, status, message: status === STATUS.DUPLICATE ? '중복 의심으로 접수되었습니다. 관리자가 확인합니다.' : '참여 등록이 접수되었습니다.' };
}

function findMySubmissions(criteria) {
  setupDatabase_();
  const data = sanitizePayload_(criteria, ['teacherName', 'team']);
  if (!data.teacherName) throw new Error('강사명을 입력해 주세요.');

  return getRows_(SHEETS.ENTRIES)
    .filter(row => row['강사명'] === data.teacherName && (!data.team || row['팀'] === data.team))
    .map(mapEntry_)
    .reverse();
}

function getMyResults(criteria) {
  const submissions = findMySubmissions(criteria);
  const approved = submissions.filter(item => item.status === STATUS.APPROVED);
  const totalAmount = approved.reduce((sum, item) => sum + item.expectedAmount, 0);
  return { submissions, approvedCount: approved.length, totalAmount };
}

function adminLogin(password) {
  const saved = PropertiesService.getScriptProperties().getProperty('ADMIN_PASSWORD') || 'admin1234';
  if (String(password || '') !== saved) throw new Error('관리자 비밀번호가 올바르지 않습니다.');
  const token = Utilities.getUuid();
  CacheService.getScriptCache().put('admin:' + token, '1', 21600);
  return { token, name: '관리자' };
}

function getAdminDashboard(token) {
  assertAdmin_(token);
  setupDatabase_();
  const entries = getRows_(SHEETS.ENTRIES).map(mapEntry_);
  return {
    counts: {
      total: entries.length,
      pending: countByStatus_(entries, STATUS.PENDING),
      approved: countByStatus_(entries, STATUS.APPROVED),
      rejected: countByStatus_(entries, STATUS.REJECTED),
      duplicate: countByStatus_(entries, STATUS.DUPLICATE)
    },
    promotions: listAllPromotions_(),
    submissions: entries.reverse(),
    results: buildResults_(entries)
  };
}

function listSubmissions(token, status) {
  assertAdmin_(token);
  const entries = getRows_(SHEETS.ENTRIES).map(mapEntry_).reverse();
  return status ? entries.filter(item => item.status === status) : entries;
}

function reviewSubmission(token, payload) {
  assertAdmin_(token);
  const data = sanitizePayload_(payload, ['id', 'status', 'reason', 'adminName']);
  if (![STATUS.APPROVED, STATUS.REJECTED].includes(data.status)) throw new Error('검수 결과는 인정 또는 반려만 가능합니다.');
  if (data.status === STATUS.REJECTED && !data.reason) throw new Error('반려 사유를 입력해 주세요.');

  const sheet = getSheet_(SHEETS.ENTRIES);
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const idIndex = headers.indexOf('등록ID');
  const statusIndex = headers.indexOf('상태');
  const reasonIndex = headers.indexOf('반려사유');
  const amountIndex = headers.indexOf('예상지급액');
  const promoIdIndex = headers.indexOf('프로모션ID');
  const rowIndex = values.findIndex((row, index) => index > 0 && row[idIndex] === data.id);
  if (rowIndex < 1) throw new Error('제출 내역을 찾을 수 없습니다.');

  const promotion = findPromotion_(values[rowIndex][promoIdIndex]);
  const amount = data.status === STATUS.APPROVED && promotion ? Number(promotion['지급단가']) || 0 : 0;
  sheet.getRange(rowIndex + 1, statusIndex + 1).setValue(data.status);
  sheet.getRange(rowIndex + 1, reasonIndex + 1).setValue(data.reason || '');
  sheet.getRange(rowIndex + 1, amountIndex + 1).setValue(amount);

  appendRow_(SHEETS.HISTORY, [new Date(), data.id, data.adminName || '관리자', data.status, data.reason || '']);
  refreshSettlement_();
  return { ok: true };
}

function getResults(token) {
  assertAdmin_(token);
  return buildResults_(getRows_(SHEETS.ENTRIES).map(mapEntry_));
}

function getResultsCsv(token) {
  assertAdmin_(token);
  const rows = [['강사명', '프로모션명', '인정건수', '예상지급액']].concat(
    buildResults_(getRows_(SHEETS.ENTRIES).map(mapEntry_)).map(row => [row.teacherName, row.promotionName, row.approvedCount, row.expectedAmount])
  );
  return rows.map(row => row.map(csvCell_).join(',')).join('\n');
}

function setupDatabase_() {
  const ss = getSpreadsheet_();
  Object.keys(HEADERS).forEach(name => {
    const sheet = ss.getSheetByName(name) || ss.insertSheet(name);
    if (sheet.getLastRow() === 0) sheet.appendRow(HEADERS[name]);
    const firstRow = sheet.getRange(1, 1, 1, HEADERS[name].length).getValues()[0];
    if (firstRow.join('') === '') sheet.getRange(1, 1, 1, HEADERS[name].length).setValues([HEADERS[name]]);
    sheet.setFrozenRows(1);
  });
  seedPromotions_();
}

function getSpreadsheet_() {
  const props = PropertiesService.getScriptProperties();
  const storedId = props.getProperty('SPREADSHEET_ID');
  if (storedId) return SpreadsheetApp.openById(storedId);
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;
  const created = SpreadsheetApp.create('프로모션 운영·검증 시스템 데이터');
  props.setProperty('SPREADSHEET_ID', created.getId());
  return created;
}

function seedPromotions_() {
  const sheet = getSheet_(SHEETS.PROMOTIONS);
  if (sheet.getLastRow() > 1) return;
  const today = new Date();
  const end = new Date(today.getFullYear(), today.getMonth() + 1, today.getDate());
  const image = 'https://images.unsplash.com/photo-1557804506-669a67965ba0?auto=format&fit=crop&w=900&q=80';
  sheet.appendRow(['PROMO-001', 'AI 디지털배움터 수강 독려', '수강생 모집과 교육 참여를 독려한 활동을 등록합니다.', image, today, end, STATUS.ACTIVE, 30000, 10]);
  sheet.appendRow(['PROMO-002', '지역 홍보 콘텐츠 공유', '승인 가능한 홍보 콘텐츠 공유 실적을 제출합니다.', image, today, end, STATUS.ACTIVE, 20000, 5]);
}

function getSheet_(name) {
  return getSpreadsheet_().getSheetByName(name);
}

function getRows_(name) {
  const sheet = getSheet_(name);
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0];
  return values.slice(1).filter(row => row.some(cell => cell !== '')).map(row => {
    const item = {};
    headers.forEach((header, index) => item[header] = row[index]);
    return item;
  });
}

function appendRow_(sheetName, row) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    getSheet_(sheetName).appendRow(row);
  } finally {
    lock.releaseLock();
  }
}

function listAllPromotions_() {
  return getRows_(SHEETS.PROMOTIONS).map(row => ({
    id: row['프로모션ID'],
    name: row['프로모션명'],
    status: row['상태'],
    period: formatDate_(row['시작일']) + ' ~ ' + formatDate_(row['종료일']),
    unitPrice: Number(row['지급단가']) || 0,
    maxCount: Number(row['최대인정횟수']) || 0
  }));
}

function mapEntry_(row) {
  return {
    id: row['등록ID'],
    receivedAt: formatDateTime_(row['접수일시']),
    teacherName: row['강사명'],
    team: row['팀'],
    promotionId: row['프로모션ID'],
    promotionName: row['프로모션명'],
    submission: row['제출내용'],
    status: row['상태'],
    rejectReason: row['반려사유'],
    expectedAmount: Number(row['예상지급액']) || 0
  };
}

function buildResults_(entries) {
  const grouped = {};
  entries.filter(item => item.status === STATUS.APPROVED).forEach(item => {
    const key = item.teacherName + '|' + item.promotionName;
    if (!grouped[key]) grouped[key] = { teacherName: item.teacherName, promotionName: item.promotionName, approvedCount: 0, expectedAmount: 0 };
    grouped[key].approvedCount += 1;
    grouped[key].expectedAmount += item.expectedAmount;
  });
  return Object.keys(grouped).map(key => grouped[key]).sort((a, b) => a.teacherName.localeCompare(b.teacherName));
}

function refreshSettlement_() {
  const sheet = getSheet_(SHEETS.SETTLEMENT);
  sheet.clearContents();
  sheet.appendRow(HEADERS[SHEETS.SETTLEMENT]);
  buildResults_(getRows_(SHEETS.ENTRIES).map(mapEntry_)).forEach(row => sheet.appendRow([row.teacherName, row.promotionName, row.approvedCount, row.expectedAmount]));
}

function findPromotion_(id) {
  return getRows_(SHEETS.PROMOTIONS).find(row => row['프로모션ID'] === id && row['상태'] === STATUS.ACTIVE);
}

function sanitizePayload_(payload, keys) {
  const source = payload || {};
  return keys.reduce((acc, key) => {
    acc[key] = String(source[key] || '').trim();
    return acc;
  }, {});
}

function assertAdmin_(token) {
  if (!token || CacheService.getScriptCache().get('admin:' + token) !== '1') {
    throw new Error('관리자 로그인이 필요합니다.');
  }
}

function countByStatus_(entries, status) {
  return entries.filter(item => item.status === status).length;
}

function dateValue_(value) {
  return startOfDay_(value instanceof Date ? value : new Date(value)).getTime();
}

function startOfDay_(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function formatDate_(value) {
  if (!value) return '';
  return Utilities.formatDate(value instanceof Date ? value : new Date(value), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function formatDateTime_(value) {
  if (!value) return '';
  return Utilities.formatDate(value instanceof Date ? value : new Date(value), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
}

function csvCell_(value) {
  const text = String(value == null ? '' : value);
  return '"' + text.replace(/"/g, '""') + '"';
}
