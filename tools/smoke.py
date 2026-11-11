#!/usr/bin/env python3
"""Optional developer smoke test: real Chrome, real DOM, three viewports.

Requires Python 3.10+, `pip install websockets`, and a local Chrome/Chromium.
The extension itself has no build step and does not need this script.

    python3 tools/smoke.py
    python3 tools/smoke.py --shots screenshots
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import json
import shutil
import socket
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

try:
    import websockets
except ImportError:
    sys.exit("需要 websockets：pip install websockets")

ROOT = Path(__file__).resolve().parents[1]
CHECKS: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    CHECKS.append((name, bool(ok), detail))
    print(("  PASS  " if ok else "  FAIL  ") + name + (("  " + str(detail)) if detail else ""))


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class CDP:
    def __init__(self, ws):
        self.ws = ws
        self.seq = 0
        self.events: list[dict] = []

    async def call(self, method: str, params: dict | None = None) -> dict:
        self.seq += 1
        ident = self.seq
        await self.ws.send(json.dumps({"id": ident, "method": method, "params": params or {}}))
        while True:
            message = json.loads(await self.ws.recv())
            if message.get("id") == ident:
                if "error" in message:
                    raise RuntimeError(method + ": " + json.dumps(message["error"]))
                return message.get("result", {})
            self.events.append(message)

    async def evaluate(self, expression: str):
        result = await self.call("Runtime.evaluate", {
            "expression": expression, "returnByValue": True, "awaitPromise": True,
        })
        if "exceptionDetails" in result:
            raise RuntimeError("JS exception: " + json.dumps(result["exceptionDetails"])[:500])
        return result.get("result", {}).get("value")

    async def screenshot(self, path: Path) -> None:
        result = await self.call("Page.captureScreenshot", {"format": "png", "captureBeyondViewport": False})
        path.write_bytes(base64.b64decode(result["data"]))

    async def viewport(self, width: int, height: int) -> None:
        await self.call("Emulation.setDeviceMetricsOverride", {
            "width": width, "height": height, "deviceScaleFactor": 1, "mobile": False,
        })
        await asyncio.sleep(0.45)
        await self.evaluate("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))")


async def run(args: argparse.Namespace) -> int:
    shots = Path(args.shots).resolve() if args.shots else None
    if shots:
        shots.mkdir(parents=True, exist_ok=True)
    port, debug_port = free_port(), free_port()
    profile = tempfile.mkdtemp(prefix="neotab-smoke-")
    url = f"http://127.0.0.1:{port}/newtab.html"
    server = subprocess.Popen(
        [sys.executable, "-m", "http.server", str(port), "--bind", "127.0.0.1"],
        cwd=str(ROOT), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    chrome = subprocess.Popen([
        shutil.which("google-chrome") or shutil.which("chromium") or "google-chrome",
        "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
        "--hide-scrollbars", f"--remote-debugging-port={debug_port}",
        "--remote-allow-origins=*", f"--user-data-dir={profile}",
        "--window-size=1440,900", "about:blank",
    ], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    try:
        for _ in range(50):
            try:
                urllib.request.urlopen(url, timeout=1).read(32)
                break
            except Exception:
                await asyncio.sleep(0.15)

        ws_url = None
        for _ in range(60):
            try:
                targets = json.load(urllib.request.urlopen(
                    f"http://127.0.0.1:{debug_port}/json/list", timeout=1))
                pages = [t for t in targets if t.get("type") == "page"]
                if pages:
                    ws_url = pages[0]["webSocketDebuggerUrl"]
                    break
            except Exception:
                pass
            await asyncio.sleep(0.25)
        if not ws_url:
            raise RuntimeError("Chrome DevTools 未启动")

        async with websockets.connect(ws_url, max_size=20 * 1024 * 1024) as ws:
            c = CDP(ws)
            await c.call("Runtime.enable")
            await c.call("Page.enable")
            await c.call("Log.enable")
            await c.call("Page.navigate", {"url": url})
            await asyncio.sleep(1.6)

            print("页面初始化")
            initial = await c.evaluate("""(() => ({
              ready: document.body.dataset.ready,
              tiles: document.querySelectorAll('#grid .tile').length,
              desks: document.querySelectorAll('.dot').length,
              pages: document.querySelectorAll('.desk-page').length,
              sidebar: !!document.querySelector('.sidebar'),
              heroHidden: document.querySelector('#hero').hidden,
              clockHidden: document.querySelector('#clock').hidden,
              formHidden: document.querySelector('#searchForm').hidden,
              iconControls: document.querySelectorAll('[data-panel="icon"] input, [data-panel="icon"] select').length,
              chips: document.querySelectorAll('#colsChips .chip').length
            }))()""")
            check("页面就绪", initial["ready"] == "1")
            check("默认桌面与图标渲染", initial["tiles"] > 0 and initial["desks"] > 0,
                  f'{initial["tiles"]} 图标 / {initial["desks"]} 桌面')
            check("废弃侧边栏，改为横向分页", (not initial["sidebar"]) and initial["pages"] == 3,
                  f'{initial["pages"]} 页')
            check("默认显示搜索栏、时钟关闭",
                  not initial["heroHidden"] and initial["clockHidden"] and not initial["formHidden"],
                  f'hero={initial["heroHidden"]} clock={initial["clockHidden"]} form={initial["formHidden"]}')
            check("图标面板只有列数一项", initial["iconControls"] == 0 and initial["chips"] > 1,
                  f'{initial["chips"]} 个列数选项 / {initial["iconControls"]} 个其它控件')

            print("桌面网格铺满度与图标尺寸")
            await c.viewport(1440, 900)
            fill = await c.evaluate("""(() => {
              const g=document.querySelector('#grid'), r=g.getBoundingClientRect();
              const icon=document.querySelector('#grid .tile-icon').getBoundingClientRect();
              return {vw:innerWidth, left:Math.round(r.left), right:Math.round(innerWidth-r.right),
                      width:Math.round(r.width), cell:Math.round(icon.width),
                      cols:+getComputedStyle(g).getPropertyValue('--cols')};
            })()""")
            check("宽屏网格铺满，两侧不再大片留白",
                  fill["left"] <= fill["vw"] * 0.06 and fill["right"] <= fill["vw"] * 0.06,
                  f'左右 {fill["left"]}/{fill["right"]}px，网格 {fill["width"]}px')
            check("宽屏图标放大到可点击尺寸", fill["cell"] >= 80,
                  f'{fill["cell"]}px / {fill["cols"]} 列')

            print("设置页 · 桌面横屏 1440x900")
            await c.viewport(1440, 900)
            await c.evaluate("NT.settings.open()")
            await asyncio.sleep(0.35)   # let the panel entry animation settle
            desktop = await c.evaluate("""(() => {
              const r=document.querySelector('.settings-panel').getBoundingClientRect();
              return {w:Math.round(r.width), nav:getComputedStyle(document.querySelector('.settings-nav')).flexDirection};
            })()""")
            check("设置页宽度自适应且不超过视口", desktop["w"] <= 1440 * 0.95, str(desktop["w"]) + "px")
            check("宽屏使用左侧菜单", desktop["nav"] == "column")
            glass = await c.evaluate("""(() => {
              const p=document.querySelector('.settings-panel');
              const d=document.querySelector('#dots');
              const t=document.querySelector('#grid .tile-icon');
              return {body:getComputedStyle(document.body).backgroundColor,
                      panel:getComputedStyle(p).backgroundColor,
                      panelBlur:getComputedStyle(p).backdropFilter,
                      dots:getComputedStyle(d).backgroundColor,
                      icon:!!(t && (t.querySelector('img') || t.querySelector('.tile-letter')))};
            })()""")
            check("除图标外全局纯透明 + 高斯模糊",
                  glass["panel"] == "rgba(0, 0, 0, 0)" and "blur" in glass["panelBlur"]
                  and glass["body"] == "rgba(0, 0, 0, 0)" and glass["icon"],
                  glass["panelBlur"])
            check("底部分页圆点为裸点（无胶囊面板）", glass["dots"] == "rgba(0, 0, 0, 0)")
            if shots:
                await c.screenshot(shots / "01-settings-desktop.png")

            print("列数设置")
            await c.evaluate("document.querySelector('#colsChips .chip[data-cols=\"8\"]').click()")
            cols = await c.evaluate("""(() => ({
              saved:NT.state.data.config.cols,
              rendered:getComputedStyle(document.querySelector('#grid')).getPropertyValue('--cols').trim()
            }))()""")
            check("列数设置即时生效", cols["saved"] == 8 and cols["rendered"] == "8")

            print("壁纸：上传即生效 + 模糊 / 遮罩")
            await c.evaluate("document.querySelector('#settingsNav [data-tab=\"wallpaper\"]').click()")
            upload = await c.evaluate("""(async () => {
              const cv=document.createElement('canvas'); cv.width=600; cv.height=400;
              const ctx=cv.getContext('2d'); ctx.fillStyle='#ff7a59'; ctx.fillRect(0,0,600,400);
              const blob=await new Promise(r=>cv.toBlob(r,'image/png'));
              await NT.wallpaper.useFile(new File([blob],'w.png',{type:'image/png'}));
              NT.wallpaper.setBlur(12); NT.wallpaper.setMask(35);
              return {kind:NT.state.data.config.wallpaper.kind,
                      applied:document.querySelector('#wallpaper').style.backgroundImage.startsWith('url("data:image'),
                      mask:document.documentElement.style.getPropertyValue('--wall-mask')};
            })()""")
            check("上传图片后立即应用", upload["kind"] == "upload" and upload["applied"])
            check("模糊度 / 遮罩生效", upload["mask"] == "0.35")
            check("无独立壁纸设置页，按钮直连本地上传", await c.evaluate(
                "!!document.querySelector('#wallpaperFile') && typeof NT.wallpaper.pickFile==='function'"
                " && !document.querySelector('#wallpaperPage, [data-panel=\"wallpaper-library\"]')"))

            print("响应式 · 手机竖屏 390x844")
            await c.evaluate("NT.settings.close(); NT.wallpaper.reset(); NT.state.data.config.cols=0; NT.state.changed({all:true})")
            await c.viewport(390, 844)
            portrait = await c.evaluate("""(() => {
              const g=document.querySelector('#grid'), r=g.getBoundingClientRect();
              return {vw:innerWidth, left:Math.round(r.left), right:Math.round(innerWidth-r.right),
                      cell:Math.round(document.querySelector('#grid .tile-icon').getBoundingClientRect().width),
                      cols:+getComputedStyle(g).getPropertyValue('--cols'),
                      overflowX:document.documentElement.scrollWidth>window.innerWidth};
            })()""")
            check("竖屏自动收敛列数且无横向溢出", portrait["cols"] >= 3 and not portrait["overflowX"],
                  str(portrait["cols"]) + " 列")
            check("竖屏网格同样接近铺满", portrait["left"] <= portrait["vw"] * 0.1
                  and portrait["right"] <= portrait["vw"] * 0.1,
                  f'左右 {portrait["left"]}/{portrait["right"]}px，图标 {portrait["cell"]}px')
            check("竖屏仍显示分页圆点", await c.evaluate(
                "!document.querySelector('#dots').hidden && getComputedStyle(document.querySelector('#dots')).display !== 'none'"))
            await c.evaluate("NT.settings.open('icon')")
            await asyncio.sleep(0.35)
            ps = await c.evaluate("""(() => {
              const r=document.querySelector('.settings-panel').getBoundingClientRect();
              return {w:Math.round(r.width),nav:getComputedStyle(document.querySelector('.settings-nav')).flexDirection};
            })()""")
            check("竖屏设置页全屏 + 横向标签", ps["w"] == 390 and ps["nav"] == "row")
            if shots:
                await c.evaluate("document.querySelector('#toast').hidden=true")
                await c.screenshot(shots / "02-settings-portrait.png")

            print("响应式 · 手机横屏 844x390")
            await c.viewport(844, 390)
            landscape = await c.evaluate("""(() => {
              const r=document.querySelector('.settings-panel').getBoundingClientRect();
              const content=document.querySelector('#settingsContent');
              return {w:Math.round(r.width),h:Math.round(r.height),
                      nav:getComputedStyle(document.querySelector('.settings-nav')).flexDirection,
                      scroll:content.scrollHeight>content.clientHeight};
            })()""")
            check("横屏设置页宽度自适应且可滚动", landscape["w"] <= 844 * 0.95 and landscape["nav"] == "row",
                  f'{landscape["w"]}x{landscape["h"]}')
            if shots:
                await c.screenshot(shots / "03-settings-landscape.png")

            print("交互")
            interaction = await c.evaluate("""(() => {
              NT.settings.close();
              const before=NT.state.activeDesk().items.length;
              NT.state.addItem({id:'smoke',type:'link',title:'测试',url:'https://example.com',icon:'',color:'',letter:'',size:'1x1'});
              NT.state.setActiveDesk(NT.state.data.desks[1].id);
              NT.search.openFinder();
              document.querySelector('#globalSearchInput').value='git';
              document.querySelector('#globalSearchInput').dispatchEvent(new Event('input'));
              return {added:NT.state.data.desks[0].items.length===before+1,tiles:document.querySelectorAll('#grid .tile').length};
            })()""")
            await asyncio.sleep(0.35)
            found = await c.evaluate("document.querySelectorAll('.search-item').length")
            check("添加 / 切桌面 / 全局查找", interaction["added"] and interaction["tiles"] > 0 and found > 0,
                  str(found) + " 条结果")

            print("站点图标自动解析")
            icon_ui = await c.evaluate("""(() => ({
              auto:!!document.querySelector('#optAutoIcon'),
              service:!!document.querySelector('#optIconService'),
              refresh:!!document.querySelector('#btnRefreshIcons'),
              inGeneral:!!document.querySelector('[data-panel="general"] #optAutoIcon'),
              defaultOn:NT.state.data.config.autoIcon===true,
              serviceOff:NT.state.data.config.iconService===false
            }))()""")
            check("图标解析开关在通用面板，不污染图标面板",
                  icon_ui["auto"] and icon_ui["service"] and icon_ui["refresh"]
                  and icon_ui["inGeneral"] and icon_ui["defaultOn"] and icon_ui["serviceOff"])

            icons = await c.evaluate("""(async () => {
              NT.icons.clear();
              const cfg=NT.state.data.config;
              const probe={type:'link',title:'Example',url:'https://example.com'};
              const on=NT.icons.candidates(probe);
              cfg.iconService=true;
              const withService=NT.icons.candidates(probe);
              cfg.iconService=false;
              cfg.autoIcon=false;
              const off=NT.icons.candidates(probe);
              cfg.autoIcon=true;
              const manual=NT.icons.candidates({type:'link',url:'https://example.com',icon:'/icons/icon-16.png'});

              // success path: a real same-origin image resolves and is cached
              const box=document.createElement('div'); box.className='tile-icon is-letter';
              box.style.cssText='position:fixed;top:4px;left:4px;width:64px;height:64px;z-index:99999';
              const img=document.createElement('img'); box.appendChild(img); document.body.appendChild(box);
              let outcome='pending';
              img.addEventListener('load',function(){outcome='load';});
              img.addEventListener('error',function(){outcome='error';});
              NT.icons.apply(img,box,{type:'link',url:'https://neotab-icon-smoke.invalid/',icon:'/icons/icon-16.png'});
              await new Promise(function(r){setTimeout(r,2500);});
              const cachedFirst=NT.icons.candidates({type:'link',url:'https://neotab-icon-smoke.invalid/another/'})[0];
              const letterAfter=box.classList.contains('is-letter');
              const natural=img.naturalWidth;
              box.remove();

              // failure path: every same-origin candidate 404s -> letter + miss cache
              NT.icons.clear();
              const badBox=document.createElement('div'); badBox.className='tile-icon';
              badBox.style.cssText='position:fixed;top:4px;left:80px;width:64px;height:64px;z-index:99999';
              const badImg=document.createElement('img'); badBox.appendChild(badImg); document.body.appendChild(badBox);
              await new Promise(function(resolve){
                const timer=setInterval(function(){
                  if(badBox.classList.contains('is-letter')){clearInterval(timer);resolve();}
                },25);
                setTimeout(function(){clearInterval(timer);resolve();},2500);
                NT.icons.apply(badImg,badBox,{type:'link',url:'https://neotab-miss-smoke.invalid/'});
              });
              const afterMiss=NT.icons.candidates({type:'link',url:'https://neotab-miss-smoke.invalid/other/'});
              const missLetter=badBox.classList.contains('is-letter') && !badImg.parentNode;
              badBox.remove();
              NT.icons.clear();
              cfg.autoIcon=true; cfg.iconService=false;
              return JSON.stringify({on:on,withService:withService,off:off,manual:manual,
                outcome:outcome,letterAfter:letterAfter,natural:natural,
                cachedFirst:cachedFirst,afterMiss:afterMiss,missLetter:missLetter});
            })()""")
            ic = json.loads(icons)
            check("多级候选：站点自身 favicon / apple-touch-icon",
                  any("/favicon.ico" in s for s in ic["on"])
                  and any("apple-touch-icon.png" in s for s in ic["on"]),
                  str(len(ic["on"])) + " 个候选")
            check("公共图标服务默认关闭、开启才加入",
                  not any("duckduckgo" in s for s in ic["on"])
                  and any("duckduckgo" in s for s in ic["withService"]))
            check("关闭自动解析后完全不产生网络候选", len(ic["off"]) == 0)
            check("手动图标地址优先", ic["manual"][0] == "/icons/icon-16.png")
            check("解析成功后显示图片并写入缓存",
                  ic["outcome"] == "load" and not ic["letterAfter"] and ic["natural"] > 0
                  and ic["cachedFirst"] == "/icons/icon-16.png",
                  f'{ic["outcome"]} / {ic["natural"]}px / 缓存 {ic["cachedFirst"]}')
            check("全部失败回退文字图标并短期记住失败",
                  ic["missLetter"] and len(ic["afterMiss"]) == 0)

            print("手机桌面式交互")
            await c.evaluate("""(() => {
              NT.settings.close(); NT.search.closeFinder(); NT.dialogs.closeDialog();
              NT.state.data.activeDeskId=NT.state.data.desks[0].id; NT.state.changed({all:true});
            })()""")
            await c.viewport(1440, 900)
            await c.evaluate("""(() => {
              const vp=document.querySelector('#deskVp');
              window.__swipeBefore=NT.state.data.activeDeskId;
              vp.dispatchEvent(new MouseEvent('mousedown',{bubbles:true,clientX:800,clientY:420,button:0}));
              window.dispatchEvent(new MouseEvent('mousemove',{bubbles:true,clientX:380,clientY:420}));
              window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,clientX:380,clientY:420}));
            })()""")
            await asyncio.sleep(0.7)
            check("跟手滑动切换桌面", await c.evaluate("NT.state.data.activeDeskId !== window.__swipeBefore"))
            before = await c.evaluate("NT.state.data.activeDeskId")
            await c.evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true}))")
            await asyncio.sleep(0.7)
            check("方向键切换桌面", await c.evaluate("NT.state.data.activeDeskId") != before)
            clean = await c.evaluate("""(() => ({
              noBadges: !document.querySelector('.tile-delete'),
              noBar: !document.querySelector('#editBar'),
              noEditingApi: typeof NT.desks.setEditing === 'undefined'
                            && typeof NT.desks.isEditing === 'undefined'
            }))()""")
            check("无编辑态残留（无删除角标 / 编辑条 / 抖动 API）",
                  clean["noBadges"] and clean["noBar"] and clean["noEditingApi"])

            print("安卓桌面式长按：菜单 / 拖动 / 合并")
            tileNative = await c.evaluate("""(() => {
              const tiles = [...document.querySelectorAll('#grid .tile')];
              return {
                anyDrag: tiles.some(n => n.draggable),
                anyImgDrag: [...document.querySelectorAll('#grid .tile img')].some(i => i.draggable)
              };
            })()""")
            check("磁贴与图标不再是原生拖拽源", not tileNative["anyDrag"] and not tileNative["anyImgDrag"])

            # 短按 + 移动：不应抬起，也不应改顺序（留给页面滑动）
            shortPress = await c.evaluate("""(async () => {
              const grid = document.querySelector('#grid');
              const t = grid.children[1];
              const r = t.getBoundingClientRect();
              const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
              const o = (x, y) => ({bubbles:true, cancelable:true, pointerId:7, isPrimary:true,
                                    pointerType:'touch', clientX:x, clientY:y, button:0});
              const before = [...grid.children].map(n => n.dataset.id).join();
              t.dispatchEvent(new PointerEvent('pointerdown', o(cx, cy)));
              await new Promise(r => setTimeout(r, 300));
              window.dispatchEvent(new PointerEvent('pointermove', o(cx + 60, cy)));
              window.dispatchEvent(new PointerEvent('pointerup', o(cx + 60, cy)));
              await new Promise(r => setTimeout(r, 60));
              return { before: before, after: [...grid.children].map(n => n.dataset.id).join(),
                       lifted: !!document.querySelector('.tile.is-lifted') };
            })()""")
            check("短按移动不触发拖动（顺序不变、无抬起）",
                  shortPress["before"] == shortPress["after"] and not shortPress["lifted"])

            # 长按 0.5 秒 → 弹出磁贴菜单；松手误触不关闭，点外部关闭
            lp = await c.evaluate("""(async () => {
              const grid = document.querySelector('#grid');
              const t = grid.children[1];
              const r = t.getBoundingClientRect();
              const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
              const o = (x, y) => ({bubbles:true, cancelable:true, pointerId:7, isPrimary:true,
                                    pointerType:'touch', clientX:x, clientY:y, button:0});
              t.dispatchEvent(new PointerEvent('pointerdown', o(cx, cy)));
              await new Promise(r => setTimeout(r, 700));
              const menu = document.querySelector('#contextMenu');
              const open = menu && !menu.hidden && menu.textContent.includes('删除');
              window.dispatchEvent(new PointerEvent('pointerup', o(cx, cy)));
              t.dispatchEvent(new MouseEvent('click', {bubbles:true}));  // 松手误触
              await new Promise(r => setTimeout(r, 60));
              const stillOpen = menu && !menu.hidden;
              await new Promise(r => setTimeout(r, 550));                // 守卫过期
              document.body.click();
              const closed = menu.hidden;
              return { open: open, stillOpen: stillOpen, closed: closed };
            })()""")
            check("长按图标弹出菜单，松手误触不关闭、点外部关闭",
                  lp["open"] and lp["stillOpen"] and lp["closed"])

            # 按住不放拖动：菜单收起 → 抬起放大 → 实时让位 → 松手落位
            drag = await c.evaluate("""(async () => {
              const grid = document.querySelector('#grid');
              const t = grid.children[1];
              const r = t.getBoundingClientRect();
              const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
              const o = (x, y) => ({bubbles:true, cancelable:true, pointerId:7, isPrimary:true,
                                    pointerType:'touch', clientX:x, clientY:y, button:0});
              window.__wpBefore = JSON.stringify(NT.state.data.config.wallpaper);
              const idsBefore = [...grid.children].map(n => n.dataset.id);
              t.dispatchEvent(new PointerEvent('pointerdown', o(cx, cy)));
              await new Promise(r => setTimeout(r, 700));      // 长按 → 菜单
              const menuOpen = !document.querySelector('#contextMenu').hidden;
              const r4 = grid.children[4].getBoundingClientRect();
              const px = r4.right - 8, py = r4.top + 8;
              window.dispatchEvent(new PointerEvent('pointermove', o(px, cy)));
              await new Promise(r => setTimeout(r, 60));
              const menuClosed = document.querySelector('#contextMenu').hidden;
              const lifted = t.classList.contains('is-lifted');
              const scale = getComputedStyle(t.querySelector('.tile-icon')).transform;
              const mScale = scale.match(/matrix\\(([\\d.]+)/);
              const big = !!(mScale && parseFloat(mScale[1]) >= 1.15);
              window.dispatchEvent(new PointerEvent('pointermove', o(px, py)));
              await new Promise(r => setTimeout(r, 90));
              const domMid = [...grid.children].map(n => n.dataset.id);
              const liveShift = domMid[1] === idsBefore[2] && domMid.join() !== idsBefore.join();
              window.dispatchEvent(new PointerEvent('pointerup', o(px, py)));
              await new Promise(r => setTimeout(r, 150));
              const idsAfter = [...grid.children].map(n => n.dataset.id);
              return {
                menuOpen: menuOpen, menuClosed: menuClosed, lifted: lifted, big: big,
                liveShift: liveShift, noLift: !document.querySelector('.tile.is-lifted'),
                noEditing: !document.querySelector('#app').classList.contains('is-editing'),
                committed: idsAfter.join() === NT.state.activeDesk().items.map(i => i.id).join()
                           && idsAfter.join() !== idsBefore.join(),
                wallSame: JSON.stringify(NT.state.data.config.wallpaper) === window.__wpBefore,
                iconLanded: idsAfter.indexOf(idsBefore[1]) === 4
              };
            })()""")
            check("按住拖动：菜单收起、图标抬起放大",
                  drag["menuOpen"] and drag["menuClosed"] and drag["lifted"] and drag["big"])
            check("松手前其他图标已实时让位", drag["liveShift"])
            check("松手后按拖动结果落位（图标落在目标槽位）",
                  drag["committed"] and drag["iconLanded"] and drag["noLift"] and drag["noEditing"])
            check("拖动图标后壁纸不变（bug 已修）", drag["wallSame"])

            # 安卓式合并：拖到另一图标中心悬停片刻 → 目标放大提示，松手成文件夹
            merge = await c.evaluate("""(async () => {
              const items = NT.state.activeDesk().items;
              const links = items.filter(i => i.type === 'link');
              const a = links[0], b = links[1];
              if (!a || !b) return { skip: true };
              const grid = document.querySelector('#grid');
              const ta = grid.querySelector('.tile[data-id="' + a.id + '"]');
              const tb = grid.querySelector('.tile[data-id="' + b.id + '"]');
              const ra = ta.getBoundingClientRect();
              const ax = ra.left + ra.width / 2, ay = ra.top + ra.height / 2;
              const o = (x, y) => ({bubbles:true, cancelable:true, pointerId:7, isPrimary:true,
                                    pointerType:'touch', clientX:x, clientY:y, button:0});
              const countBefore = NT.state.activeDesk().items.length;
              ta.dispatchEvent(new PointerEvent('pointerdown', o(ax, ay)));
              await new Promise(r => setTimeout(r, 700));      // 长按 → 菜单 + 可拖
              for (let i = 0; i < 6; i++) {
                const rb = tb.getBoundingClientRect();
                window.dispatchEvent(new PointerEvent('pointermove',
                  o(rb.left + rb.width / 2, rb.top + rb.height / 2)));
                await new Promise(r => setTimeout(r, 90));
              }
              const ready = tb.classList.contains('is-merge-target');
              const rb = tb.getBoundingClientRect();
              window.dispatchEvent(new PointerEvent('pointerup',
                o(rb.left + rb.width / 2, rb.top + rb.height / 2)));
              await new Promise(r => setTimeout(r, 200));
              const folder = NT.state.activeDesk().items.find(i => i.type === 'folder'
                && i.children && i.children.some(c => c.id === a.id)
                && i.children.some(c => c.id === b.id));
              return {
                ready: ready, merged: !!folder,
                count: NT.state.activeDesk().items.length === countBefore - 1,
                popup: !document.querySelector('#folderLayer').hidden
              };
            })()""")
            check("拖到图标上悬停合并为文件夹并自动打开",
                  merge["ready"] and merge["merged"] and merge["count"] and merge["popup"])
            await c.evaluate("NT.dialogs.closeFolder()")

            # 壁纸 drop 防护：磁贴内丢图片文件不换壁纸；空白处仍可换
            dropGuard = await c.evaluate("""(async () => {
              const dt = new DataTransfer();
              dt.items.add(new File([new Blob(['x'])], 'icon.png', {type: 'image/png'}));
              const before = JSON.stringify(NT.state.data.config.wallpaper);
              const tile = document.querySelector('#grid .tile .tile-icon');
              tile.dispatchEvent(new DragEvent('drop', {bubbles:true, cancelable:true, dataTransfer:dt}));
              const afterTile = JSON.stringify(NT.state.data.config.wallpaper);
              document.body.dispatchEvent(new DragEvent('drop', {bubbles:true, cancelable:true, dataTransfer:dt}));
              await new Promise(r => setTimeout(r, 450));   // useFile 异步压缩后写配置
              const afterBody = JSON.stringify(NT.state.data.config.wallpaper);
              Object.assign(NT.state.data.config.wallpaper, JSON.parse(before));
              NT.state.changed({wallpaper:true});
              return { blocked: afterTile === before, applied: afterBody !== before };
            })()""")
            check("磁贴内拖放不触发换壁纸，空白处拖图仍可换壁纸",
                  dropGuard["blocked"] and dropGuard["applied"])

            print("WebDAV 同步")
            # 内存 WebDAV 服务器：不发起真实请求，完整实现 MKCOL / PROPFIND /
            # PUT / GET / DELETE，并记录方法与 Basic 认证头。
            await c.evaluate("""(() => {
              window.__dav = {files:{}, mtime:{}, dirs:{}, calls:[], clock:0, auth:'', failGet:0};
              const D = window.__dav;
              window.fetch = async function(url, opt){
                opt = opt || {};
                const m = opt.method || 'GET';
                const p = new URL(url, location.href).pathname.slice(1).replace(/\\/$/, '');
                const h = opt.headers || {};
                D.calls.push({m:m, p:p});
                if (h.Authorization) D.auth = h.Authorization;
                if (m === 'MKCOL') {
                  if (D.dirs[p]) return new Response('', {status:405});
                  D.dirs[p] = 1; return new Response('', {status:201});
                }
                if (m === 'PROPFIND') {
                  if (!D.dirs[p]) return new Response('', {status:404});
                  const names = Object.keys(D.files).filter(n => n.indexOf(p + '/') === 0);
                  const xml = '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">' + names.map(n =>
                    '<d:response><d:href>/' + n + '</d:href><d:propstat><d:prop>' +
                    '<d:displayname>' + n.split('/').pop() + '</d:displayname>' +
                    '<d:getlastmodified>' + new Date(D.mtime[n] || Date.now()).toUTCString() + '</d:getlastmodified>' +
                    '<d:getcontentlength>' + String(D.files[n]).length + '</d:getcontentlength>' +
                    '</d:prop></d:propstat></d:response>').join('') + '</d:multistatus>';
                  return new Response(xml, {status:207});
                }
                if (m === 'PUT') {
                  const parent = p.split('/').slice(0, -1).join('/');
                  if (!D.dirs[parent]) return new Response('', {status:409});
                  D.files[p] = String(opt.body || '');
                  D.mtime[p] = Date.now() + 3600000 + (++D.clock);
                  return new Response('', {status:201});
                }
                if (m === 'GET') {
                  if (D.failGet) return new Response('', {status:D.failGet});
                  if (!(p in D.files)) return new Response('', {status:404});
                  return new Response(D.files[p], {status:200});
                }
                if (m === 'DELETE') {
                  delete D.files[p]; delete D.mtime[p];
                  return new Response(null, {status:204});
                }
                return new Response('', {status:405});
              };
              return true;
            })()""")

            dav0 = await c.evaluate("""(() => ({
              api: !!window.__neotabWebdav && !!NT.webdav,
              dir: NT.webdav.DIR, keep: NT.webdav.KEEP,
              configured: !!NT.webdav.getConfig().url,
              calls: window.__dav.calls.length,
              tab: !!document.querySelector('[data-tab="sync"]'),
              host: !!document.querySelector('.webdav-inline-host')
            }))()""")
            check("WebDAV 模块可用且默认不联网",
                  dav0["api"] and not dav0["configured"] and dav0["calls"] == 0
                  and dav0["dir"] == "neotab-backup" and dav0["keep"] == 10)
            check("设置页有独立「同步」tab 与内嵌宿主", dav0["tab"] and dav0["host"])

            await c.evaluate("NT.settings.open('sync')")
            await asyncio.sleep(0.25)
            panel = await c.evaluate("""(() => {
              const dlg = document.querySelector('.webdav-inline-host .neotab-webdav-dialog');
              const sec = document.querySelector('.webdav-sync-panel .wd-section');
              return {
                inline: !!dlg,
                glass: dlg ? getComputedStyle(dlg).backgroundColor : '',
                blur: sec ? getComputedStyle(sec).backdropFilter : '',
                local: !!document.querySelector('[data-panel="sync"] #btnExport')
                       && !!document.querySelector('[data-panel="sync"] #btnImport'),
                form: !!(dlg && dlg.querySelector('.wd-url') && dlg.querySelector('.wd-backup')),
                status: dlg ? dlg.querySelector('.wd-status').textContent : ''
              };
            })()""")
            check("同步页内嵌面板 + 本地导入导出入口",
                  panel["inline"] and panel["form"] and panel["local"])
            check("同步面板沿用透明 + 高斯模糊主题",
                  panel["glass"] in ("rgba(0, 0, 0, 0)", "transparent")
                  and "blur(32px)" in panel["blur"], panel["blur"])

            # 保存配置（走真实表单事件）→ 首次 PROPFIND 目录不存在
            await c.evaluate("""(() => {
              const d = document.querySelector('.webdav-inline-host');
              d.querySelector('.wd-url').value = 'http://127.0.0.1:9/dav/';
              d.querySelector('.wd-user').value = 'smoke';
              d.querySelector('.wd-pass').value = 'secret';
              d.querySelector('.wd-save').click();
            })()""")
            await asyncio.sleep(0.4)
            cfg = await c.evaluate("NT.webdav.getConfig()")
            check("保存配置写入 webdavConfig",
                  cfg.get("url") == "http://127.0.0.1:9/dav/" and cfg.get("username") == "smoke")

            # 手动备份：首次 PUT 409 -> 自动 MKCOL 建目录 -> 重试 -> 写 latest.json
            await c.evaluate("document.querySelector('.webdav-inline-host .wd-backup').click()")
            await asyncio.sleep(0.9)
            up = await c.evaluate("""(() => {
              const D = window.__dav, base = 'dav/neotab-backup/';
              const names = Object.keys(D.files);
              let payload = null;
              try { payload = JSON.parse(D.files[base + 'latest.json']); } catch (e) {}
              return {
                names: names,
                methods: D.calls.map(x => x.m),
                auth: D.auth,
                marker: payload && payload._neotabWebdav,
                format: payload && payload.data && payload.data.format,
                desks: payload && payload.data && payload.data.desks && payload.data.desks.length,
                kind: payload && payload._kind,
                status: document.querySelector('.webdav-inline-host .wd-status').textContent,
                lastSync: NT.webdav.getConfig().lastSync,
                items: document.querySelectorAll('.webdav-inline-host .wd-item').length
              };
            })()""")
            manual = [n for n in up["names"] if n.startswith("dav/neotab-backup/neotab-")
                      and not n.startswith("dav/neotab-backup/neotab-auto-") and n.endswith(".json")]
            check("目录不存在时自动 MKCOL 后重传",
                  "MKCOL" in up["methods"] and "PUT" in up["methods"] and "PROPFIND" in up["methods"])
            check("HTTP Basic 认证头正确",
                  up["auth"] == "Basic " + base64.b64encode(b"smoke:secret").decode(),
                  up["auth"])
            check("备份写入时间戳文件 + latest.json（neotab 格式）",
                  len(manual) == 1 and up["marker"] == 1 and up["format"] == "neotab"
                  and up["desks"] > 0 and up["kind"] == "manual",
                  str(manual))
            check("同步水位与云端备份列表刷新",
                  bool(up["lastSync"]) and "备份成功" in up["status"] and up["items"] >= 2,
                  up["status"])

            if shots:
                await c.viewport(1440, 900)
                await c.evaluate("document.querySelector('#toast').hidden=true")
                # Hide the in-memory test credentials for the public screenshot,
                # then restore them so later checks still see the real form state.
                await c.evaluate("""(() => {
                  document.querySelectorAll('.webdav-inline-host .wd-url, .webdav-inline-host .wd-user, .webdav-inline-host .wd-pass')
                    .forEach((i) => { i.dataset.shotValue = i.value; i.value = ''; });
                })()""")
                await c.screenshot(shots / "08-settings-webdav.png")
                await c.evaluate("""(() => {
                  document.querySelectorAll('.webdav-inline-host [data-shot-value]')
                    .forEach((i) => { i.value = i.dataset.shotValue; delete i.dataset.shotValue; });
                })()""")

            # 任何变更 3 秒防抖自动上传；预置 12 份 auto 备份验证只保留 10 份
            await c.evaluate("""(() => {
              const D = window.__dav, base = 'dav/neotab-backup/';
              for (let i = 0; i < 12; i++) {
                const k = base + 'neotab-auto-old-' + i + '.json';
                D.files[k] = '{}'; D.mtime[k] = Date.now() - (30 - i) * 60000;
              }
              D.calls.length = 0;
              NT.state.changed({grid:true});
              return true;
            })()""")
            await asyncio.sleep(3.8)
            auto = await c.evaluate("""(() => {
              const D = window.__dav, base = 'dav/neotab-backup/';
              const autos = Object.keys(D.files).filter(n => n.indexOf(base + 'neotab-auto-') === 0);
              const manual = Object.keys(D.files).filter(n => n.indexOf(base + 'neotab-') === 0
                && n.indexOf(base + 'neotab-auto-') !== 0 && n !== base + 'latest.json');
              let payload = null;
              try { payload = JSON.parse(D.files[base + 'latest.json']); } catch (e) {}
              return {
                autos: autos.length, manual: manual.length,
                deletes: D.calls.filter(x => x.m === 'DELETE').length,
                puts: D.calls.filter(x => x.m === 'PUT').map(x => x.p),
                kind: payload && payload._kind
              };
            })()""")
            check("任何变更 3 秒防抖自动上传",
                  auto["kind"] == "auto" and any("neotab-auto-" in p for p in auto["puts"]))
            check("自动备份轮换保留 10 份、手动备份不清理",
                  auto["autos"] == 10 and auto["deletes"] == 3 and auto["manual"] == 1,
                  f'{auto["autos"]} 份 / 删除 {auto["deletes"]} 份')

            # 启动拉取：云端有更新的 neotab 格式备份 -> 应用到本地
            await c.evaluate("""(() => {
              const D = window.__dav, k = 'dav/neotab-backup/latest.json';
              D.files[k] = JSON.stringify({
                _neotabWebdav:1, _time:Date.now() + 60000, _version:2, _kind:'manual',
                data:{format:'neotab', version:1, config:{}, activeDeskId:'cloud', notes:'', todos:[],
                  desks:[{id:'cloud', name:'云端备份', glyph:'云', items:[
                    {id:'ci1', type:'link', title:'云端站点', url:'https://example.com', size:'1x1'}]}]}
              });
              D.calls.length = 0;
              window.__beforeSync = NT.state.data.desks.map(d => d.name);
              return window.__beforeSync;
            })()""")
            synced = await c.evaluate("NT.webdav.syncCheck(true)")
            pull = await c.evaluate("""(() => ({
              before: window.__beforeSync,
              after: NT.state.data.desks.map(d => d.name),
              lastSync: NT.webdav.getConfig().lastSync,
              puts: window.__dav.calls.filter(x => x.m === 'PUT').length,
              toast: document.querySelector('#toast').textContent
            }))()""")
            check("启动拉取云端新版本并应用",
                  synced is True and "云端备份" in pull["after"]
                  and "云端备份" not in pull["before"] and bool(pull["lastSync"]))
            check("自有格式备份可直接导入",
                  "云端备份" in pull["after"], str(pull["after"]))
            check("云端数据落地后不回推，避免同步风暴", pull["puts"] == 0)

            # 401 专项诊断（走 syncCheck，避免 backup 的 console.error 污染控制台检查）
            await c.evaluate("window.__dav.failGet = 401")
            denied = await c.evaluate("NT.webdav.syncCheck(true)")
            toast401 = await c.evaluate("document.querySelector('#toast').textContent")
            check("401 给出应用密码与重定向诊断",
                  denied is False and "认证失败(401)" in toast401 and "应用密码" in toast401,
                  toast401[:60])

            # 收尾：清空配置恢复默认零联网，并验证离开 tab 会收起内嵌面板
            await c.evaluate("""(() => {
              window.__dav.failGet = 0;
              NT.webdav.saveConfig({});
              NT.settings.switchTab('icon');
              NT.settings.close();
            })()""")
            left = await c.evaluate("""(() => {
              const d = document.querySelector('.neotab-webdav-mask');
              return {parent: d && d.parentNode.tagName, display: d && d.style.display,
                      inline: d && d.classList.contains('neotab-webdav-inline'),
                      url: NT.webdav.getConfig().url || ''};
            })()""")
            check("离开同步 tab 收起面板且恢复默认不联网",
                  left["parent"] == "BODY" and left["display"] == "none"
                  and not left["inline"] and left["url"] == "")

            await c.viewport(390, 844)
            await c.evaluate("NT.settings.open('sync')")
            await asyncio.sleep(0.3)
            narrow = await c.evaluate("""(() => {
              const panel = document.querySelector('.webdav-sync-panel');
              const dlg = document.querySelector('.webdav-inline-host .neotab-webdav-dialog');
              const url = dlg && dlg.querySelector('.wd-url');
              const row = document.querySelector('.webdav-sync-panel .wd-row');
              return {
                w: panel ? Math.round(panel.getBoundingClientRect().width) : 0,
                vw: innerWidth,
                overflowX: document.documentElement.scrollWidth > innerWidth,
                inputW: url ? Math.round(url.getBoundingClientRect().width) : 0,
                wrap: row ? getComputedStyle(row).flexWrap : ''
              };
            })()""")
            check("竖屏同步面板自适应、不横向溢出",
                  narrow["w"] <= narrow["vw"] and narrow["inputW"] <= narrow["w"]
                  and not narrow["overflowX"] and narrow["wrap"] == "wrap",
                  f'{narrow["w"]}/{narrow["vw"]}px, 输入框 {narrow["inputW"]}px')
            await c.evaluate("NT.settings.close()")
            await c.viewport(1440, 900)

            errors = []
            for event in c.events:
                if event.get("method") == "Runtime.exceptionThrown":
                    errors.append("exception: " + json.dumps(event["params"].get("exceptionDetails", {}))[:250])
                elif event.get("method") == "Runtime.consoleAPICalled" and event["params"].get("type") == "error":
                    errors.append("console.error: " + " ".join(
                        str(a.get("value", ""))[:150] for a in event["params"].get("args", [])))
                elif event.get("method") == "Log.entryAdded":
                    entry = event["params"]["entry"]
                    # The icon resolver deliberately probes several per-site
                    # paths; a 404 / unreachable host is an expected fallback,
                    # not a script error. Keep every non-network log entry.
                    if entry.get("level") != "error":
                        continue
                    if entry.get("source") == "network" or "Failed to load resource" in entry.get("text", ""):
                        continue
                    errors.append("log: " + entry.get("text", "")[:200])
            check("控制台零报错", len(errors) == 0, "; ".join(errors[:3]))

            if shots:
                print("生成主界面截图")
                await c.evaluate("""(() => {
                  NT.search.closeFinder(); NT.dialogs.closeDialog(); NT.dialogs.closeMenu();
                  NT.state.reset(); document.querySelector('#toast').hidden=true;
                })()""")
                await c.viewport(1440, 900)
                await asyncio.sleep(0.5)
                await c.evaluate("document.querySelector('#toast').hidden=true")
                await c.screenshot(shots / "00-desktop.png")
                await c.viewport(390, 844)
                await c.evaluate("document.querySelector('#toast').hidden=true")
                await c.screenshot(shots / "04-portrait.png")
                print("  截图目录:", shots)

            failed = [name for name, ok, _ in CHECKS if not ok]
            print(f"\n{len(CHECKS) - len(failed)}/{len(CHECKS)} 项通过")
            return 1 if failed else 0
    finally:
        for process in (chrome, server):
            process.terminate()
            try:
                process.wait(timeout=5)
            except Exception:
                process.kill()
        shutil.rmtree(profile, ignore_errors=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="NeoTab 真浏览器冒烟测试")
    parser.add_argument("--shots", metavar="DIR", help="额外输出桌面 / 竖屏 / 横屏截图到该目录")
    return asyncio.run(run(parser.parse_args()))


if __name__ == "__main__":
    sys.exit(main())
