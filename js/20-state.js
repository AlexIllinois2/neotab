/* NeoTab — state model, local defaults, and backup decoding.
   Stored shape: { version, config, desks, activeDeskId, notes } */
(function (global) {
  'use strict';
  const NT = global.NT;
  const U = NT.util;
  const STORAGE_KEY = 'neotab.state.v1';

  const ENGINES = {
    baidu: { title: '百度', href: 'https://www.baidu.com/s?wd=' },
    bing: { title: '必应', href: 'https://www.bing.com/search?q=' },
    google: { title: 'Google', href: 'https://www.google.com/search?q=' },
    duckduckgo: { title: 'DuckDuckGo', href: 'https://duckduckgo.com/?q=' },
    so: { title: '360 搜索', href: 'https://www.so.com/s?q=' }
  };

  const DEFAULT_CONFIG = {
    cols: 0,                       // 0 = automatic; the ONLY icon setting
    wallpaper: { kind: 'preset', preset: 'nebula', mask: 10, blur: 28, value: '', name: '' },
    iconBlank: true,
    searchBlank: true,
    searchShow: true,              // search bar visible by default (clock stays off)
    clockShow: false,
    clock24: true,
    notesShow: false,
    autoIcon: true,                // resolve site favicons automatically
    iconService: false,            // public fallback service is opt-in
    engine: 'bing'
  };

  function link(title, url, extra) {
    return Object.assign({ id: U.uid(), type: 'link', title: title, url: url, icon: '', color: '', letter: '', size: '1x1' }, extra || {});
  }
  function folder(title, children, extra) {
    return Object.assign({ id: U.uid(), type: 'folder', title: title, children: children || [], size: '1x1' }, extra || {});
  }
  function desk(name, glyph, items) {
    return { id: U.uid(), name: name, glyph: glyph || name.charAt(0), items: items || [] };
  }

  /* Starter set of sites supplied by the author. Icons resolve live via
     favicons; letter and colour stay as fallback when a request fails. */
  const DEFAULT_DESKS = [
    {
      name: "主页",
      items: [
        { title: "ChaGPT", url: "https://chatgpt.com/", letter: "Cha", color: "#ffffff" },
        { title: "GitHub", url: "https://github.com/", color: "#000" },
        { title: "Google", url: "https://www.google.com/", color: "#fff" },
        { title: "DuckDuckGo", url: "https://start.duckduckgo.com/", letter: "Duc", color: "#023373" },
        { title: "Cloudflare", url: "https://dash.cloudflare.com/", letter: "Clo" },
        { title: "tutamail", url: "https://app.tuta.com/mail", letter: "Tut", color: "#fc4548" },
        { title: "Twitter", url: "https://twitter.com/", color: "#000000" },
        { folder: "bbs", children: [{ title: "bluesky", url: "https://bsky.app/", color: "#fc4548" }, { title: "reddit", url: "https://www.reddit.com/", letter: "red" }, { title: "nodeseek", url: "https://www.nodeseek.com/", letter: "NS", color: "#4b3c36" }] },
        { folder: "novel", children: [{ title: "小说之家", url: "https://xszj.org/", letter: "小说之", color: "#f9620e" }, { title: "海棠", url: "https://ebook.longmabook.com/", color: "#33c5c5" }] },
        { folder: "editor", children: [{ title: "Tavafa", url: "https://www.tavafa.com/sign.html", letter: "Tav", color: "#023373" }, { title: "OpenCut", url: "https://opencut.app/projects", letter: "Ope", color: "#13ae67" }] },
        { folder: "apk", children: [{ title: "Quetta", url: "https://www.quetta.net", letter: "Que", color: "#f01313" }, { title: "localsend", url: "https://localsend.org/zh-CN/download?os=android", letter: "Loc", color: "#a3ddb9" }, { title: "vlc", url: "https://mirrors.aliyun.com/videolan/vlc-android/last", letter: "mir" }] },
        { folder: "apk", children: [{ title: "APKMirror", url: "https://www.apkmirror.com/", letter: "APK" }, { title: "Play Store", url: "https://play.google.com/store", letter: "Pla", color: "#fff" }, { title: "Obtainium Apps", url: "https://apps.obtainium.imranr.dev/", letter: "Obt", color: "#ffffff" }] },
        { folder: "apk", children: [{ title: "Obtainium", url: "https://github.com/ImranR98/Obtainium/releases", letter: "Git", color: "#000" }, { title: "komi-store", url: "https://github.com/kurikomi-labs/komi-store", letter: "Git", color: "#000" }, { title: "gkd", url: "https://github.com/gkd-kit/gkd/releases", letter: "Git", color: "#000" }, { title: "syncthing", url: "https://github.com/109car/syncthing-android-v2/releases", letter: "Git", color: "#000" }, { title: "Voice-Recorder", url: "https://github.com/FossifyOrg/Voice-Recorder/releases", letter: "Git", color: "#000" }, { title: "Xime", url: "https://github.com/ximeiorg/Xime/releases", letter: "Git", color: "#000" }, { title: "Simple-Gallery", url: "https://github.com/SimpleMobileTools/Simple-Gallery/releases", letter: "Git", color: "#000" }, { title: "markor", url: "https://github.com/gsantner/markor/releases", letter: "Git", color: "#000" }, { title: "darkmodewallpaper", url: "https://github.com/cvzi/darkmodewallpaper/releases", letter: "Git", color: "#000" }, { title: "bbspace", url: "https://github.com/naaammme/bbspace/releases", letter: "Git", color: "#000" }, { title: "legado", url: "https://github.com/Rimchars/legado/releases", letter: "Git", color: "#000" }, { title: "Voice", url: "https://github.com/PaulWoitaschek/Voice/releases", letter: "Git", color: "#000" }, { title: "stratumauth", url: "https://github.com/stratumauth/app/releases", letter: "Git", color: "#000" }, { title: "tutanota", url: "https://github.com/tutao/tutanota/releases", letter: "Git", color: "#000" }, { title: "aRDP", url: "https://github.com/iiordanov/remote-desktop-clients/releases", letter: "Git", color: "#000" }, { title: "ImageToolbox", url: "https://github.com/T8RIN/ImageToolbox/releases", letter: "Git", color: "#000" }, { title: "LibreCuts", url: "https://github.com/tharunbirla/LibreCuts/releases", letter: "Git", color: "#000" }, { title: "ab-download", url: "https://github.com/amir1376/ab-download-manager/releases", letter: "Git", color: "#000" }, { title: "gopeed", url: "https://github.com/GopeedLab/gopeed/releases", letter: "Git", color: "#000" }, { title: "Kazumi", url: "https://github.com/Predidit/Kazumi/releases", letter: "Git", color: "#000" }, { title: "Sshd4a", url: "https://github.com/tfonteyn/Sshd4a/releases", letter: "Git", color: "#000" }, { title: "APlayer", url: "https://github.com/rRemix/APlayer/releases", letter: "Git", color: "#000" }, { title: "android-code-studio", url: "https://github.com/AndroidCSOfficial/android-code-studio/releases", letter: "Git", color: "#000" }, { title: "ClashMetaForAndroid", url: "https://github.com/MetaCubeX/ClashMetaForAndroid/releases", letter: "Git", color: "#000" }] },
        { folder: "apk(priv)", children: [{ title: "KernelSU-Next", url: "https://github.com/KernelSU-Next/KernelSU-Next/releases", letter: "Git", color: "#000" }, { title: "Shizuku", url: "https://github.com/thedjchi/Shizuku/releases", letter: "Git", color: "#000" }, { title: "Hail", url: "https://github.com/aistra0528/Hail/releases", letter: "Git", color: "#000" }, { title: "InstallerX", url: "https://github.com/wxxsfxyzm/InstallerX-Revived/releases", letter: "Git", color: "#000" }, { title: "Thanox", url: "https://github.com/Tornaco/Thanox/releases", letter: "Git", color: "#000" }, { title: "awesome-android-root", url: "https://github.com/awesome-android-root/awesome-android-root", letter: "Git", color: "#000" }, { title: "ShizukuDhizuku-list", url: "https://github.com/UrkeJH/ShizukuDhizuku-list", letter: "Git", color: "#000" }] },
        { folder: "ksu-module", children: [{ title: "ZygiskNext", url: "https://github.com/LSPosed/ZygiskNext/releases", letter: "Git", color: "#000" }, { title: "susfs4ksu", url: "https://github.com/sidex15/susfs4ksu-module", letter: "Git", color: "#000" }, { title: "LSPosed", url: "https://github.com/LSPosed/LSPosed/releases", letter: "Git", color: "#000" }, { title: "ViPER4Android", url: "https://github.com/likelikeslike/ViPER4Android", letter: "Git", color: "#000" }, { title: "kernelsu-modules", url: "https://github.com/topics/kernelsu-module", letter: "Git", color: "#000" }] },
        { folder: "android-rom", children: [{ title: "malachite_rom", url: "https://t.me/s/redmi_note_14proplusupdates?q=%23Malachite", letter: "TIM" }, { title: "mt6878-da", url: "https://github.com/MTK-bypass/exploits_collection/issues/69", letter: "Web", color: "#4b4b4b" }, { title: "xda", url: "https://xdaforums.com/", color: "#ffffff" }, { title: "infinity-x", url: "https://sourceforge.net/projects/infinity-x/files/begonia/", letter: "TeX" }, { title: "xda-红米n8p", url: "https://xdaforums.com/f/redmi-note-8-pro-roms-kernels-recoveries-othe.9295/", color: "#ffffff" }] },
        { folder: "iso", children: [{ title: "ventoy", url: "https://www.ventoy.net/cn/download.html", letter: "Dow", color: "#ffffff" }, { title: "firpe", url: "https://www.firpe.cn/?sid=U3FOqN#down", letter: "Fir", color: "#1681ff" }] },
        { folder: "linux", children: [{ title: "Flathub", url: "https://flathub.org/zh-Hans/apps/collection/popular/1", letter: "Fla" }, { title: "yazi指南", url: "https://imwnk.cn/archives/yazi-file-manager-guide/", letter: "王宁凯" }] },
        { folder: "linux-app", children: [{ title: "clash-verge-rev", url: "https://github.com/clash-verge-rev/clash-verge-rev/releases", letter: "Git", color: "#000" }, { title: "mark-shot", url: "https://github.com/jswysnemc/mark-shot/releases", letter: "Git", color: "#000" }, { title: "rustdesk", url: "https://github.com/rustdesk/rustdesk/releases", letter: "Git", color: "#000" }, { title: "sidex", url: "https://github.com/Sidenai/sidex/releases", letter: "Git", color: "#000" }, { title: "gopeed", url: "https://github.com/GopeedLab/gopeed/releases", letter: "Git", color: "#000" }, { title: "FluxDown", url: "https://github.com/zerx-lab/FluxDown/releases", letter: "Git", color: "#000" }, { title: "shotcut", url: "https://github.com/mltframework/shotcut/releases", letter: "Git", color: "#000" }, { title: "Clypra", url: "https://github.com/AIEraDev/Clypra/releases", letter: "Git", color: "#000" }, { title: "pdfcraft", url: "https://github.com/PDFCraftTool/pdfcraft/releases", letter: "Git", color: "#000" }, { title: "MoeKoeMusic", url: "https://github.com/MoeKoeMusic/MoeKoeMusic/releases", letter: "Git", color: "#000" }, { title: "alt-sendme", url: "https://github.com/tonyantony300/alt-sendme/releases", letter: "Git", color: "#000" }] },
        { folder: "linux-cmd", children: [{ title: "topgrade", url: "https://github.com/topgrade-rs/topgrade/releases", letter: "Git", color: "#000" }, { title: "witr", url: "https://github.com/pranshuparmar/witr/releases", letter: "Git", color: "#000" }, { title: "tailcat", url: "https://github.com/tailscale/tailcat/releases", letter: "Git", color: "#000" }, { title: "EasyTier", url: "https://github.com/EasyTier/EasyTier", letter: "Git", color: "#000" }, { title: "slim", url: "https://github.com/nilbuild/slim/releases", letter: "Git", color: "#000" }, { title: "herdr", url: "https://github.com/herdrdev/herdr/releases", letter: "Git", color: "#000" }, { title: "yadm", url: "https://software.opensuse.org//download.html?project=home%3ATheLocehiliosan%3Ayadm&package=yadm", letter: "YADM" }, { title: "neko-master", url: "https://github.com/foru17/neko-master/releases" }] }
      ]
    },
    {
      name: "live",
      items: [
        { title: "DeepSeek", url: "https://chat.deepseek.com/", letter: "Dee", color: "#fff" },
        { folder: "ai", children: [{ title: "智谱清言", url: "https://chatglm.cn/apps?image=https%3A%2F%2Fsfile.chatglm.cn%2Factiveimg%2Fbdms%2F66b97e348217030036f486f1", color: "#ffffff" }, { title: "Kimi", url: "https://www.kimi.com/", color: "#000000" }, { title: "腾讯元宝", url: "https://yuanbao.tencent.com/chat", letter: "腾讯元" }] },
        { folder: "agent", children: [{ title: "Z.ai", url: "https://chat.z.ai/", letter: "Z.a", color: "#fc4548" }, { title: "AgentMore", url: "https://agentmore.chatglm.cn/", letter: "Age", color: "#e67e22" }, { title: "WorkBuddy", url: "https://www.workbuddy.cn/app", letter: "Wor", color: "#fff" }] },
        { folder: "mirror", children: [{ title: "GitHub加速", url: "https://gh-proxy.com/", letter: "Git", color: "#7dac68" }, { title: "GitHub Proxy", url: "https://ghproxy.link/", letter: "Git", color: "#2ecc71" }, { title: "sourceforge-mir", url: "https://gh-proxy.com/sourceforge/", letter: "Git", color: "#c8ac70" }, { title: "docker加速", url: "https://proxy.pipers.cn/", color: "#c8ac70" }, { title: "HF-Mirror", url: "https://hf-mirror.com/models?search=Uncensored", letter: "HF-", color: "#e74c3c" }, { title: "阿里mir-vlc", url: "https://mirrors.aliyun.com/videolan/vlc-android/last/?spm=a2c6h.25603864.0.0.45344ed7gygYaP", letter: "mir" }] },
        { folder: "dev", children: [{ title: "应用宝开放平台", url: "https://app.open.qq.com/p/home", letter: "应用宝", color: "#c8ac70" }, { title: "版权中心", url: "https://register.ccopyright.com.cn/account.html?current=soft_register", letter: "中国版", color: "#13ae67" }] },
        { title: "电鸭社区", url: "https://eleduck.com/", letter: "电鸭社" },
        { title: "163邮箱", url: "http://mail.163.com/", color: "#e8011e" },
        { folder: "live", children: [{ title: "闲鱼", url: "https://2.taobao.com", color: "#ffe50e" }, { title: "淘宝网", url: "http://ads.taobao.com?bc_fl_src=tbsite_s8ZdSIzq&channelSrp=tbsy-lianxiang", color: "#ff5c00" }, { title: "京东商城", url: "https://www.jd.com/", color: "#ff0000" }, { title: "高德地图", url: "https://ditu.amap.com", color: "#ffffff" }] },
        { title: "知乎", url: "https://www.zhihu.com/", color: "#0c6dfe" },
        { title: "小红书", url: "https://www.xiaohongshu.com/explore", color: "#ff2442" },
        { title: "哔哩哔哩", url: "https://www.bilibili.com/", color: "#ff5ca1" },
        { title: "抖音", url: "https://www.douyin.com/?ug_source=pc_liangxiang_01", letter: "抖音", color: "#1c0b1a" },
        { folder: "novel", children: [{ title: "盐选(1234)", url: "https://www.yanxuan.org/", letter: "盐选", color: "#c82c34" }, { title: "Yiove 书源", url: "https://shuyuan.yiove.com/book-source-collections?page=1&page_size=20", letter: "Yio", color: "#fbbe23" }] },
        { title: "阿里云盘", url: "https://www.alipan.com/drive/home", letter: "阿里云", color: "#e74c3c" },
        { title: "123云盘", url: "https://yun.123pan.cn/", letter: "123", color: "#ee3b3b" },
        { title: "爱路导航", url: "https://ipath8.com/", letter: "爱路网", color: "#0071c0" },
        { folder: "resource", children: [{ title: "QuarkTube", url: "https://www.quarktube.com/", letter: "Qua", color: "#fbbe23" }, { title: "小众技术资源库", url: "https://www.xiaozhongjishu.com/" }, { title: "爱资源", url: "https://www.iwyu.com/", color: "#22a5e2" }] },
        { folder: "yt-dlp", children: [{ title: "hellotik", url: "https://www.hellotik.app/zh", color: "#fbbe23" }, { title: "抖音视频下载", url: "https://www.xiazaitool.com/dy", letter: "无水印", color: "#e74c3c" }] },
        { folder: "tool-box", children: [{ title: "百度识图", url: "https://graph.baidu.com/pcpage/index?tpl_from", letter: "百度识", color: "#0071c0" }] },
        { folder: "android-rom", children: [{ title: "ROM 中心", url: "https://opusrom.top/", letter: "ROM", color: "#4b3c36" }, { title: "小米rom", url: "https://xiaomirom.com/series/", color: "#054092" }, { title: "安卓-123云盘", url: "https://www.123865.com/s/r5sDVv-xQ4pH?notoken=1", letter: "123", color: "#f9620e" }, { title: "红米n8p-123云盘", url: "https://www.123865.com/s/r5sDVv-4Q4pH?notoken=1", letter: "123", color: "#a3ddb9" }] },
        { title: "ScriptCat", url: "https://scriptcat.org/zh-CN", letter: "Get", color: "#ffffff" },
        { title: "扩展搜搜", url: "https://www.crxsoso.com/", color: "#fff" },
        { title: "今日热榜", url: "https://tophub.today/", color: "#fff" },
        { title: "UU", url: "http://localhost:5173/devices/aeawvsrb6abee3ll/control", letter: "UU" }
      ]
    }
  ];

  function hydrateItems(items) {
    return items.map(function (raw) {
      if (raw.folder) return folder(raw.folder, hydrateItems(raw.children));
      return link(raw.title, raw.url, { letter: raw.letter || '', color: raw.color || '' });
    });
  }

  function createDefault() {
    const desks = DEFAULT_DESKS.map(function (d) { return desk(d.name, '', hydrateItems(d.items)); });
    return {
      version: 1,
      config: JSON.parse(JSON.stringify(DEFAULT_CONFIG)),
      desks: desks,
      activeDeskId: desks[0].id,
      notes: '',
      todos: []
    };
  }

  /* ---- backup -------------------------------------------------------------- */
  const SIZE_OK = { '1x1': 1, '2x1': 1, '1x2': 1, '2x2': 1, '2x4': 1 };

  function safeSize(value) {
    return SIZE_OK[String(value || '')] ? String(value) : '1x1';
  }

  /** Decode a NeoTab backup (an object or JSON text) into a fresh state. */
  function readBackup(input) {
    let raw = input;
    if (typeof raw === 'string') raw = JSON.parse(raw);
    if (!raw || raw.format !== 'neotab' || !Array.isArray(raw.desks)) {
      throw new Error('不是有效的 NeoTab 备份文件');
    }
    const fresh = createDefault();
    return {
      data: {
        version: 1,
        config: Object.assign(fresh.config, raw.config || {}),
        desks: raw.desks.length ? normalizeDesks(raw.desks) : fresh.desks,
        activeDeskId: raw.activeDeskId || (raw.desks[0] && raw.desks[0].id) || '',
        notes: String(raw.notes || ''),
        todos: Array.isArray(raw.todos) ? raw.todos : []
      },
      stats: { desks: raw.desks.length, items: countItems(raw.desks) }
    };
  }

  function countItems(desks) {
    let n = 0;
    (desks || []).forEach(function (d) {
      (d.items || []).forEach(function (item) { n += 1 + ((item.children || []).length); });
    });
    return n;
  }

  function normalizeDesks(desks) {
    // 按 id 去重：老版本「拖入文件夹」bug 会把同一项既留在桌面列表又塞进
    // 文件夹 children（同 id 双份）。文件夹内子项优先占位，桌面残留让位。
    const seen = Object.create(null);
    const reserved = Object.create(null);
    (desks || []).forEach(function (d) {
      (d.items || []).forEach(function (item) {
        if (item && item.type === 'folder') {
          (item.children || []).forEach(function (c) { if (c && c.id) reserved[c.id] = true; });
        }
      });
    });
    function dedupe(list, dropReserved) {
      return list.filter(function (item) {
        if (item.id && dropReserved && reserved[item.id]) return false;
        if (item.id && seen[item.id]) return false;
        if (item.id) seen[item.id] = true;
        return true;
      });
    }
    return desks.map(function (d) {
      return {
        id: d.id || U.uid(),
        name: String(d.name || '桌面').slice(0, 24),
        glyph: d.glyph || String(d.name || '桌').charAt(0),
        items: dedupe((d.items || []).map(function (item) {
          const copy = Object.assign({}, item);
          copy.id = copy.id || U.uid();
          copy.size = safeSize(copy.size);
          if (copy.type === 'folder') copy.children = dedupe((copy.children || []).map(function (child) {
            return Object.assign({ id: U.uid(), size: '1x1' }, child);
          }), false);
          return copy;
        }), true)
      };
    });
  }

  /* ---- live state --------------------------------------------------------- */
  const state = {
    data: createDefault(),
    load: function () {
      return NT.storage.get(STORAGE_KEY, null).then(function (saved) {
        if (saved && Array.isArray(saved.desks) && saved.desks.length) {
          const fresh = createDefault();
          const merged = Object.assign(fresh.config, saved.config || {});
          merged.wallpaper = Object.assign(JSON.parse(JSON.stringify(DEFAULT_CONFIG.wallpaper)), (saved.config && saved.config.wallpaper) || {});
          state.data = {
            version: 1,
            config: merged,
            desks: normalizeDesks(saved.desks),
            activeDeskId: saved.activeDeskId || saved.desks[0].id,
            notes: String(saved.notes || ''),
            todos: Array.isArray(saved.todos) ? saved.todos : []
          };
          if (!state.data.desks.some(function (d) { return d.id === state.data.activeDeskId; })) {
            state.data.activeDeskId = state.data.desks[0].id;
          }
        }
        return state.data;
      });
    },
    save: U.debounce(function () {
      return NT.storage.set(STORAGE_KEY, state.data).catch(function () {
        U.toast('本地存储写入失败，改动仅在本次会话有效', true);
      });
    }, 220),
    changed: function (flags) {
      state.save();
      NT.bus.emit('state:change', flags || {});
    },
    reset: function () {
      state.data = createDefault();
      NT.blobs.remove('wallpaper').catch(function () {});
      state.changed({ all: true });
    },
    replace: function (next) {
      state.data = next;
      state.changed({ all: true });
    },
    activeDesk: function () {
      return state.data.desks.find(function (d) { return d.id === state.data.activeDeskId; }) || state.data.desks[0];
    },
    setActiveDesk: function (id) {
      if (!state.data.desks.some(function (d) { return d.id === id; })) return;
      state.data.activeDeskId = id;
      state.changed({ desks: true, grid: true });
    },
    findItem: function (id) {
      for (let i = 0; i < state.data.desks.length; i++) {
        const d = state.data.desks[i];
        const list = d.items;
        for (let j = 0; j < list.length; j++) {
          if (list[j].id === id) return { item: list[j], list: list, index: j, desk: d };
          const children = list[j].children || [];
          for (let k = 0; k < children.length; k++) {
            if (children[k].id === id) return { item: children[k], list: children, index: k, desk: d, parent: list[j] };
          }
        }
      }
      return null;
    },
    addItem: function (item, deskId, index) {
      const target = deskId ? state.data.desks.find(function (d) { return d.id === deskId; }) : state.activeDesk();
      if (!target) return;
      if (typeof index === 'number') target.items.splice(index, 0, item);
      else target.items.push(item);
      state.changed({ grid: true });
    },
    removeItem: function (id) {
      const found = state.findItem(id);
      if (!found) return;
      found.list.splice(found.index, 1);
      state.changed({ grid: true });
    },
    addDesk: function (name) {
      const d = desk(name || ('桌面 ' + (state.data.desks.length + 1)));
      state.data.desks.push(d);
      state.data.activeDeskId = d.id;
      state.changed({ desks: true, grid: true });
      return d;
    },
    removeDesk: function (id) {
      if (state.data.desks.length <= 1) return false;
      const i = state.data.desks.findIndex(function (d) { return d.id === id; });
      if (i < 0) return false;
      state.data.desks.splice(i, 1);
      if (state.data.activeDeskId === id) state.data.activeDeskId = state.data.desks[Math.min(i, state.data.desks.length - 1)].id;
      state.changed({ desks: true, grid: true });
      return true;
    },
    allItems: function () {
      const out = [];
      state.data.desks.forEach(function (d) {
        (d.items || []).forEach(function (item) {
          out.push({ item: item, desk: d });
          (item.children || []).forEach(function (child) { out.push({ item: child, desk: d, parent: item }); });
        });
      });
      return out;
    }
  };

  NT.ENGINES = ENGINES;
  NT.DEFAULT_CONFIG = DEFAULT_CONFIG;
  NT.state = state;
  NT.backup = { read: readBackup };
})(window);
