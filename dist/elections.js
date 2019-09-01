"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const puppeteer = require("puppeteer");
const util = require("util");
const fs = require("fs");
const csv = require("fast-csv");
const writeFile = util.promisify(fs.writeFile);
async function preparePage(page) {
    await page.setViewport({ width: 1600, height: 1200 });
    page.on('dialog', async (d) => await d.dismiss());
}
async function getPersonalInfo(browser, url) {
    const page = await browser.newPage();
    await preparePage(page);
    try {
        await page.goto(url, { waitUntil: ['load', 'networkidle0'] });
        const cells = await page.$x('//td/table[last()]//tr[position()>1]/td[3]');
        const text = await Promise.all(cells.map(async (el) => await page.evaluate((item) => (item.textContent || '').trim(), el)));
        return {
            p_name: text[0],
            p_dob: text[1],
            p_bplace: text[2],
            p_lplace: text[3],
            p_education: text[4],
            p_workplace: text[5],
            p_position: text[6],
            p_deputy: text[7],
            p_criminalRecs: text[8],
            p_status: text[9],
            p_screenshot: await page.screenshot({ type: 'jpeg', encoding: 'binary', fullPage: true })
        };
    }
    catch (e) {
        console.log('E:', url);
        throw e;
    }
    finally {
        await page.close();
    }
}
async function parseReportRow(browser, page, row) {
    const cells = await row.$$('td');
    let res;
    const text = await Promise.all(cells.map(async (el) => await page.evaluate((item) => item.textContent || '', el)));
    switch (cells.length) {
        case 8:
            res = {
                number: parseInt(text[0], 10),
                url: await page.evaluate((item) => { const x = item.querySelector('a'); return x ? x.getAttribute('href') || '' : ''; }, cells[1]),
                name: text[1].trim(),
                dob: text[2].trim(),
                partyOrSubject: text[3].trim(),
                constituencyNr: parseInt(text[4], 10),
                regGroupNo: null,
                regGroup: null,
                nrInGroup: null,
                nomination: text[5].trim(),
                registration: text[6].trim(),
                election: text[7].trim()
            };
            break;
        case 10:
            res = {
                number: parseInt(text[0], 10),
                url: await page.evaluate((item) => { const x = item.querySelector('a'); return x ? x.getAttribute('href') || '' : ''; }, cells[1]),
                name: text[1].trim(),
                dob: text[2].trim(),
                partyOrSubject: text[3].trim(),
                constituencyNr: null,
                regGroupNo: parseInt(text[4], 10),
                regGroup: text[5].trim(),
                nrInGroup: parseInt(text[6], 10),
                nomination: text[7].trim(),
                registration: text[8].trim(),
                election: text[9].trim()
            };
            break;
        default:
            throw new Error("Don't know how to handle this report");
    }
    res.info = await getPersonalInfo(browser, res.url);
    return res;
}
async function parseElectionReport(browser, url) {
    const page = await browser.newPage();
    await preparePage(page);
    const result = {
        candidates: [],
        url
    };
    try {
        await page.goto(url, { waitUntil: ['load', 'networkidle0'] });
        let element = await page.$('a[href="#"][onclick]');
        if (element) {
            await Promise.all([
                page.waitForNavigation({ waitUntil: 'networkidle0' }),
                element.click()
            ]);
        }
        const rows = await page.$$('table table[id^="table-"] > tbody > tr');
        for (const row of rows) {
            result.candidates.push(await parseReportRow(browser, page, row));
        }
        result.screenshot = await page.screenshot({
            type: 'jpeg',
            encoding: 'binary',
            fullPage: true
        });
        return result;
    }
    catch (e) {
        console.log('E:', url);
        throw e;
    }
    finally {
        await page.close();
    }
}
async function parseElectionsPage(browser, url) {
    const page = await browser.newPage();
    await preparePage(page);
    try {
        await page.goto(url, { waitUntil: ['load', 'networkidle0'] });
        const elements = await page.$$('td.tdReport a[href*="type=220"]');
        const urls = await Promise.all(elements.map(async (el) => await page.evaluate((item) => item.getAttribute('href') || '', el)));
        const result = [];
        for (const url of urls) {
            result.push(await parseElectionReport(browser, url));
        }
        return result;
    }
    catch (e) {
        console.log('E:', url);
        throw e;
    }
    finally {
        await page.close();
    }
}
async function save(e) {
    const url = new URL(e.url);
    const vrn = url.searchParams.get('vrn') || '';
    const csvstream = csv.format();
    const out = fs.createWriteStream(`./elections/e_${vrn}.csv`, { mode: 0o644 });
    csvstream.pipe(out);
    for (const report of e.reports) {
        const url = new URL(report.url);
        const vrn = url.searchParams.get('vrn') || '';
        const rm = url.searchParams.get('report_mode') || '0';
        for (const candidate of report.candidates) {
            const { info } = candidate;
            const { p_screenshot } = info;
            delete candidate.info;
            delete info.p_screenshot;
            const url = new URL(candidate.url);
            const row = Object.assign(Object.assign({ electionName: e.name, electionUrl: e.url, reportUrl: report.url, vrn, cid: url.searchParams.get('vibid') || '' }, candidate), info);
            csvstream.write(row);
            await writeFile(`./elections/c_${row.cid}.jpg`, p_screenshot);
        }
        if (report.screenshot) {
            await writeFile(`./elections/e_${vrn}_${rm}.jpg`, report.screenshot);
        }
    }
}
async function main(browser) {
    try {
        const pages = await browser.pages();
        let page;
        let elements;
        if (pages) {
            page = pages[0];
        }
        else {
            page = await browser.newPage();
        }
        await preparePage(page);
        await page.goto('http://www.crimea.vybory.izbirkom.ru/region/crimea', { waitUntil: ['load', 'networkidle0'] });
        elements = await page.$$('a.vibLink');
        const elections = await Promise.all(elements.map(async (el) => {
            return await page.evaluate((item) => {
                return {
                    url: item.getAttribute('href') || '',
                    name: item.textContent || '',
                    reports: []
                };
            }, el);
        }));
        for (const election of elections) {
            console.log(election.url);
            election.reports = await parseElectionsPage(browser, election.url);
            await save(election);
        }
    }
    finally {
        await browser.close();
    }
}
try {
    fs.mkdirSync('./elections', { mode: 0o755 });
}
catch (e) {
    if (e.code !== 'EEXIST') {
        throw e;
    }
}
puppeteer.launch({
    headless: !true
}).then(main);
//# sourceMappingURL=elections.js.map