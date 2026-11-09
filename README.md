# 一词 OneWord

每次，只记一个意思。极简背单词微信小程序与可直接使用的网页，奶白、森林绿和浅柠檬黄，让注意力留给单词。

- 默认一个核心义，可展开其他释义与例句；可开启「先回忆，再揭晓」。
- 左滑不认识、右滑认识，按钮支持不确定；可撤销，词集随最新判断自动整理。
- 支持记忆优先、字母 A–Z、每日稳定随机三种学习顺序；均先复习到期词，再学新词，跨词书共享记忆。
- 首页和学习设置均可选择顺序，下一组生效，备份保留偏好；每天新词目标可调。
- 不认识 5 分钟、不确定 15 分钟重见；到期成功回忆按 1、2、4、7、15、30、60、90 天递进。提前练习不会刷高记忆等级。此为透明的间隔启发式，非 FSRS 拟合或遗忘率保证。
- 无需注册，学习记录保存在设备；网页和微信支持兼容 JSON 备份恢复。
- 9 本离线精选各 180 词；还可下载完整源标签词库后离线使用。小学、初中、高中、四级、六级、考研、雅思、托福、GRE。SAT 尚在整理，未假称已收录。

网页已上线：<https://togetherbetter.cn/oneword/>；仓库：<https://github.com/xiangxiang222/oneword>（私有）。[产品 PR #1](https://github.com/xiangxiang222/oneword/pull/1) 已合并并自动部署，当前本地验证为 66 项测试和 18 组浏览器检查通过。

[手机首页](docs/previews/home-mobile.png) · [学习词卡](docs/previews/study-mobile.png) · [词书页](docs/previews/books-mobile.png) · [桌面首页](docs/previews/home-desktop.png)

## 开发

Node.js 20+（线上 20.20.2，CI 22）。

```sh
npm run install:all
npm run dev
# http://127.0.0.1:5186/oneword/
# 下载完整词库的本地接口另开终端运行 npm start
npm run build
npm start
# http://127.0.0.1:3795/oneword/
npm test
npm run test:browser
```

微信开发者工具打开 **miniprogram/**。首次先运行 `npm run prepare:clients` 生成共享文件。`touristappid` 用于本地导入；正式体验版和发布需要独立 AppID、运营主体及微信审核。[微信发布说明](docs/wechat-release.md)。原生微信未接商业发音服务，仅提供音标；网页朗读使用设备语音。

## 产品与数据

[竞品及研究](docs/research.md) · [产品设计](docs/product.md) · [部署与维护](docs/deployment.md) · [验收记录](docs/acceptance.md)

词库来自 [ECDICT](https://github.com/skywind3000/ECDICT)，保留 [MIT 许可](data/ECDICT-LICENSE.txt) 与 [数据出处](data/provenance.json)。人工校订常见核心义，其他词义从源数据提取；完整词书按上游标签过滤，**不能视为当前官方考试大纲或声称覆盖全部考试用词**。上游多来源数据仍需在商业运营前持续核查并校订词义。词库构建脚本 `scripts/build-vocabulary.py` 记录源文件 SHA 与筛选方法。

完整词书通过只读接口下载。网页缓存在 IndexedDB，微信用分片设备存储；未联网也能学习内置精选和已缓存词书。备份只保存学习记录与已用完整词书清单，换设备恢复时需重新联网下载对应词书。不会自动跨设备同步，不采集姓名、手机号、位置或学习记录。

## PR 与部署

在功能分支完成提交后运行 `npm run pr`，自动推送并创建 PR，等待全部检查通过后合并。`main` 的检查成功触发 GitHub Actions 部署，失败保留前版。服务器与参考项目共用主机，应用隔离在 `/var/www/oneword`、端口 `3795`、PM2 进程 `oneword`；HTTPS 路径 `/oneword/`。密钥在 GitHub Secrets，未入库。
