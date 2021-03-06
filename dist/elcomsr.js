"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const puppeteer = require("puppeteer");
const util = require("util");
const fs = require("fs");
const csv = require("fast-csv");
const writeFile = util.promisify(fs.writeFile);
async function preparePage(page) {
    await page.setViewport({ width: 1024, height: 768 });
    page.on('dialog', async (d) => await d.dismiss());
}
async function parseMembers(page, rows) {
    const result = [];
    for (const row of rows) {
        const cells = await row.$$('td');
        const text = await Promise.all(cells.map(async (el) => await page.evaluate((item) => (item.textContent || '').trim(), el)));
        const person = {
            number: parseInt(text[0]),
            name: text[1],
            status: text[2],
            offeredBy: text[3]
        };
        result.push(person);
    }
    return result;
}
async function processElCom(browser, url) {
    const page = await browser.newPage();
    await preparePage(page);
    try {
        await page.goto(url, { waitUntil: ['load', 'networkidle0'] });
        const [[elName], elRows] = await Promise.all([
            page.$x('//div[@class="center-colm"]/h2[1]'),
            page.$x('//div[@class="center-colm"]//div/table//tr[position()>2]')
        ]);
        const result = {
            url,
            name: await page.evaluate((item) => (item.textContent || '').trim(), elName),
            members: await parseMembers(page, elRows),
            screenshot: await page.screenshot({ type: 'jpeg', encoding: 'binary', fullPage: true })
        };
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
async function save(c) {
    if (!c.members.length) {
        return;
    }
    const [vrn] = c.url.match(/\d+$/);
    const csvstream = csv.format();
    const out = fs.createWriteStream(`./elcoms/r_${vrn}.csv`, { mode: 0o644 });
    csvstream.pipe(out);
    for (const member of c.members) {
        const row = Object.assign({ c_url: c.url, c_name: c.name, vrn }, member);
        csvstream.write(row);
    }
    await writeFile(`./elcoms/r_${vrn}.jpg`, c.screenshot);
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
        await page.goto('http://www.crimea.vybory.izbirkom.ru/crimea/ik_r/', { waitUntil: ['load', 'networkidle0'] });
        elements = await page.$$('#tree li[id]');
        const urls = await Promise.all(elements.map(async (el) => await page.evaluate((item) => `http://www.crimea.vybory.izbirkom.ru/crimea/ik_r/${item.id}`, el)));
        for (const url of urls) {
            console.log(url);
            const commission = await processElCom(browser, url);
            await save(commission);
        }
    }
    finally {
        await browser.close();
    }
}
try {
    fs.mkdirSync('./elcoms', { mode: 0o755 });
}
catch (e) {
    if (e.code !== 'EEXIST') {
        throw e;
    }
}
puppeteer.launch({
    headless: true
}).then(main);
//# sourceMappingURL=elcomsr.js.map