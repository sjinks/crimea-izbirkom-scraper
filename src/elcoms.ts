import puppeteer from 'puppeteer';
import PendingXHR from 'pending-xhr-puppeteer';
import { createWriteStream, mkdirSync, promises } from 'fs';
import { format } from 'fast-csv';

async function preparePage(page: puppeteer.Page): Promise<void> {
    await page.setViewport({ width: 1024, height: 768 });
    page.on('dialog', async (d: puppeteer.Dialog): Promise<void> => await d.dismiss());
}

interface Person {
    number: number;
    name: string;
    status: string;
    offeredBy: string;
}

interface Commission {
    url: string;
    name: string;
    address: string;
    members: Person[];
    screenshot: Buffer;
}

async function parseMembers(page: puppeteer.Page, rows: puppeteer.ElementHandle<Element>[]): Promise<Person[]> {
    const result: Person[] = [];

    for (const row of rows) {
        const cells = await row.$$('td');
        const text = await Promise.all(
            cells.map(async (el: puppeteer.ElementHandle<Element>): Promise<string> => await page.evaluate((item: Element): string => (item.textContent || '').trim(), el))
        );

        const person: Person = {
            number: parseInt(text[0]),
            name: text[1],
            status: text[2],
            offeredBy: text[3]
        };

        result.push(person);
    }

    return result;
}

async function processElCom(browser: puppeteer.Browser, url: string): Promise<Commission> {
    const page: puppeteer.Page = await browser.newPage();
    await preparePage(page);

    try {
        await page.goto(url, { waitUntil: ['load', 'networkidle0'] });

        const [[elName], elAddress, elRows] = await Promise.all([
            page.$x('//div[@class="center-colm"]/h2[1]'),
            page.$('#address_ik > span'),
            page.$x('//div[@class="center-colm"]//div/table//tr[position()>1]')
        ]);

        const result: Commission = {
            url,
            name: await page.evaluate((item: Element): string => (item.textContent || '').trim(), elName),
            address: await page.evaluate((item: Element): string => (item.textContent || '').trim(), elAddress),
            members: await parseMembers(page, elRows),
            screenshot: await page.screenshot({ type: 'jpeg', encoding: 'binary', fullPage: true })
        };

        return result;
    } catch (e) {
        console.log('E:', url);
        throw e;
    } finally {
        await page.close();
    }
}

async function save(c: Commission): Promise<void> {
    const url = new URL(c.url);
    const vrn = url.searchParams.get('vrn') || '';

    const csvstream = format();
    const out = createWriteStream(`./elcoms/c_${vrn}.csv`, { mode: 0o644 });
    csvstream.pipe(out);

    for (const member of c.members) {
        const row = {
            c_url: c.url,
            c_name: c.name,
            c_address: c.address,
            vrn,
            ...member
        };

        csvstream.write(row);
    }

    await promises.writeFile(`./elcoms/c_${vrn}.jpg`, c.screenshot);
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
        await page.goto('http://www.crimea.vybory.izbirkom.ru/region/crimea?action=ik', { waitUntil: ['load', 'networkidle0'] });

        const pendingXHR = new PendingXHR.PendingXHR(page);
        await page.evaluate(() => {
            document.querySelectorAll('#tree ul li ul li i.jstree-icon.jstree-ocl').forEach(x => (x as HTMLElement).click());
        });

        await pendingXHR.waitForAllXhrFinished();
        await page.waitForTimeout(1000);
        
        elements = await page.$$('#tree li[id]');
        const urls = await Promise.all(
            elements.map(async (el: puppeteer.ElementHandle<Element>): Promise<string> => await page.evaluate((item: HTMLElement): string => `http://www.crimea.vybory.izbirkom.ru/region/crimea?action=ik&vrn=${item.id}`, el))
        );

        for (const url of urls) {
            console.log(url);
            const commission = await processElCom(browser, url);
            await save(commission);
        }
    } finally {
        await browser.close();
    }
}

try {
    mkdirSync('./elcoms', { mode: 0o755 });
} catch (e) {
    if (e.code !== 'EEXIST') {
        throw e;
    }
}

puppeteer.launch({
    headless: true
}).then(main);
