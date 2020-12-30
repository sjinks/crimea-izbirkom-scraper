import puppeteer from 'puppeteer';
import { createWriteStream, mkdirSync, promises } from 'fs';
import { format } from 'fast-csv';
import Tesseract from 'tesseract.js';
import { PendingXHR } from 'pending-xhr-puppeteer';

interface PersonalInfo {
    p_name: string;
    p_dob: string;
    p_bplace: string;
    p_lplace: string;
    p_education: string;
    p_workplace: string;
    p_position: string;
    p_deputy: string;
    p_criminalRecs: string;
    p_status: string;
    p_screenshot: Buffer;
}

interface Candidate {
    number: number;                 // № п/п
    url: string;
    name: string;                   // ФИО кандидата
    dob: string;                    // Дата рождения кандидата
    partyOrSubject: string;         // Партия / Субьект выдвижения
    constituencyNr: number | null;  // Номер округа (Сведения о кандидатах, выдвинутых по одномандатным (многомандатным) избирательным округам)
    regGroupNo: number | null;      // Номер региональной группы (Сведения о списке кандидатов, выдвинутых политическими партиями)
    regGroup: string | null;        // Общесубъектовая часть, региональная группа (Сведения о списке кандидатов, выдвинутых политическими партиями)
    nrInGroup: number | null;       // Номер в общесубъектовой части, региональной группе (Сведения о списке кандидатов, выдвинутых политическими партиями)
    nomination: string;             // Статус кандидата: выдвижение
    registration: string;           // Статус кандидата: регистрация
    election: string;               // Статус кандидата: избрание
    info?: PersonalInfo;
}

async function preparePage(page: puppeteer.Page): Promise<void> {
    await page.setViewport({ width: 1600, height: 1200 });
    page.on('dialog', async (d: puppeteer.Dialog): Promise<void> => await d.dismiss());
}

async function solveCaptcha(page: puppeteer.Page, captcha: Buffer): Promise<void> {
    let c: Buffer = captcha;

    while (true) {
        const data = await Tesseract.recognize(c, 'eng');
        const text = data.data.text.replace(/ /g, '');
        await page.type('#captcha', text);
        await page.waitForSelector('#send', { visible: true });

        const [validationResponse] = await Promise.all([
            page.waitForResponse((r) => r.url().indexOf('/captcha-service/validate/captcha/value/') !== -1),
            page.click('#send'),
        ]);

        if (validationResponse.ok()) {
            break;
        }

        const newImage = await page.waitForResponse((r) => r.url().indexOf('/captcha-service/image') !== -1);
        c = await newImage.buffer();
    }

    await page.waitForNavigation({ waitUntil: ['load', 'networkidle0'] });
}

async function getPersonalInfo(browser: puppeteer.Browser, url: string): Promise<PersonalInfo> {
    const page: puppeteer.Page = await browser.newPage();
    await preparePage(page);

    try {
        await page.goto(url, { waitUntil: ['load', 'networkidle0'] });

        const cells = await page.$x('//td/table[last()]//tr[position()>1]/td[3]');
        const text = await Promise.all(
            cells.map(async (el: puppeteer.ElementHandle<Element>): Promise<string> => await page.evaluate((item: Element): string => (item.textContent || '').trim(), el))
        );

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
    } catch (e) {
        console.log('E:', url);
        throw e;
    } finally {
        await page.close();
    }
}

async function parseReportRow(browser: puppeteer.Browser, page: puppeteer.Page, row: puppeteer.ElementHandle<Element>): Promise<Candidate> {
    const cells = await row.$$('td');
    let res: Candidate;
    const text = await Promise.all(
        cells.map(async (el: puppeteer.ElementHandle<Element>): Promise<string> => await page.evaluate((item: Element): string => item.textContent || '', el))
    );

    switch (cells.length) {
        case 8:
            res = {
                number: parseInt(text[0], 10),
                url: await page.evaluate((item: Element): string => { const x: Element | null = item.querySelector('a'); return x ? x.getAttribute('href') || '' : '' }, cells[1]),
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
                url: await page.evaluate((item: Element): string => { const x: Element | null = item.querySelector('a'); return x ? x.getAttribute('href') || '' : '' }, cells[1]),
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

interface ElectionReport {
    candidates: Candidate[];
    url: string;
    screenshot?: Buffer;
}

async function parseElectionReport(browser: puppeteer.Browser, url: string): Promise<ElectionReport> {
    const page: puppeteer.Page = await browser.newPage();
    await preparePage(page);

    const result: ElectionReport = {
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
        if (!rows.length) {
            console.error('Report has no rows');
        }

        for (const row of rows) {
            result.candidates.push(await parseReportRow(browser, page, row));
        }

        result.screenshot = await page.screenshot({
            type: 'jpeg',
            encoding: 'binary',
            fullPage: true
        });

        return result;
    } catch (e) {
        console.log('E:', url);
        throw e;
    } finally {
        await page.close();
    }
}

async function parseElectionsPage(browser: puppeteer.Browser, url: string): Promise<ElectionReport[]> {
    const page: puppeteer.Page = await browser.newPage();
    await preparePage(page);

    try {
        let captcha: Buffer | undefined;

        const detector = async (r: puppeteer.Request) => {
            if (r.url().indexOf('/captcha-service/image') !== -1) {
                const resp = r.response();
                if (resp) {
                    captcha = await resp.buffer();
                }
            }
        };

        page.on('requestfinished', detector);
        await page.goto(url, { waitUntil: ['load', 'networkidle0'] });
        page.off('requestfinished', detector);

        if (captcha) {
            await solveCaptcha(page, captcha);
        }

        const elements: puppeteer.ElementHandle<Element>[] = await page.$$('td.tdReport a[href*="type=220"]');
        const urls = await Promise.all(
            elements.map(async (el: puppeteer.ElementHandle<Element>): Promise<string> => await page.evaluate((item: Element): string => item.getAttribute('href') || '', el))
        );

        const result: ElectionReport[] = [];
        for (const url of urls) {
            result.push(await parseElectionReport(browser, url));
        }

        return result;
    } catch (e) {
        console.log('E:', url);
        throw e;
    } finally {
        await page.close();
    }
}

interface Election {
    url: string;
    name: string;
    reports: ElectionReport[];
}

async function save(e: Election): Promise<void> {
    const url = new URL(e.url);
    const vrn = url.searchParams.get('vrn') || '';

    const csvstream = format();
    const out = createWriteStream(`./elections/e_${vrn}.csv`, { mode: 0o644 });
    csvstream.pipe(out);

    for (const report of e.reports) {
        const url = new URL(report.url);
        const vrn = url.searchParams.get('vrn') || '';
        const rm = url.searchParams.get('report_mode') || '0';

        for (const candidate of report.candidates) {
            const { info } = candidate;
            const { p_screenshot } = info as PersonalInfo;

            const url = new URL(candidate.url);

            const row = {
                electionName: e.name,
                electionUrl: e.url,
                reportUrl: report.url,
                vrn,
                cid: url.searchParams.get('vibid') || '',
                ...candidate,
                ...info,
            };

            csvstream.write(row);
            await promises.writeFile(`./elections/c_${row.cid}.jpg`, p_screenshot);
        }

        if (report.screenshot) {
            await promises.writeFile(`./elections/e_${vrn}_${rm}.jpg`, report.screenshot);
        }
    }
}

async function main(browser: puppeteer.Browser): Promise<void> {
    try {
        const pages = await browser.pages();
        let page: puppeteer.Page;
        let elements: puppeteer.ElementHandle<Element>[];
        if (pages) {
            page = pages[0];
        } else {
            page = await browser.newPage();
        }

        await preparePage(page);
        await page.goto('http://www.crimea.vybory.izbirkom.ru/region/crimea', { waitUntil: ['load', 'networkidle0'] });

        await page.focus('#start_date');
        await page.keyboard.down('ControlLeft');
        await page.keyboard.press('KeyA');
        await page.keyboard.up('ControlLeft');
        await page.keyboard.press('Delete');
        await page.type('#start_date', '01.11.2019');

        await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle0' }),
            page.click('form[name="calendar"] input[type="submit"]')
        ]);

        elements = await page.$$('a.vibLink');
        const elections = await Promise.all(
            elements.map(async (el: puppeteer.ElementHandle<Element>): Promise<Election> => {
                return await page.evaluate((item: Element): Election => {
                    return {
                        url: item.getAttribute('href') || '',
                        name: item.textContent || '',
                        reports: []
                    };
                }, el);
            })
        );

        for (const election of elections) {
            console.log(election.url);
            election.reports = await parseElectionsPage(browser, election.url);
            await save(election);
        }
    } finally {
        await browser.close();
    }
}

try {
    mkdirSync('./elections', { mode: 0o755 });
} catch (e) {
    if (e.code !== 'EEXIST') {
        throw e;
    }
}

puppeteer.launch({
    headless: !true
}).then(main);
