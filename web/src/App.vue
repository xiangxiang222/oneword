<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Icon from './Icon.vue'
import AccountPanel from './AccountPanel.vue'
import { connectCloud } from './cloud.js'
import core from './generated/core.js'
import vocabulary from './generated/vocabulary.js'
import { downloadBook, installedBooks, restoreBookManifest } from './catalog.js'

const { books, words, wordMap } = vocabulary
const STORAGE = 'oneword.v1'
const RECOVERY_STORAGE = STORAGE + '.recovery'
const page = ref(location.hash.slice(1) || 'home')
const toast = ref('')
let toastTimer
function notify(message) { toast.value = message; clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.value = '', 3200) }
const storageAvailable = ref(true)
const recoverySnapshot = ref('')
let recoveryPersisted = false
function loadState() {
  let saved = ''
  try {
    saved = localStorage.getItem(STORAGE) || ''
    recoverySnapshot.value = localStorage.getItem(RECOVERY_STORAGE) || ''
    recoveryPersisted = !!recoverySnapshot.value
    return saved ? core.restoreState(saved) : core.createState()
  } catch {
    storageAvailable.value = false
    if (saved) {
      recoverySnapshot.value = saved
      try { localStorage.setItem(RECOVERY_STORAGE, saved); recoveryPersisted = true }
      catch { recoveryPersisted = false }
    }
    return core.createState()
  }
}
const state = ref(loadState())
let cloud = null
let lastRating = null
const cloudStatus = ref({user:null,phase:'guest',message:'游客模式 · 记录保存在本机'})
function save(next, fromCloud=false, applicationId) {
  if (!fromCloud && cloud) {
    try {
      const stored=JSON.parse(localStorage.getItem('oneword.cloud.identity.v1') || 'null')
      if ((stored?.user?.id || null)!==(cloud.getStatus().user?.id || null)) {
        notify('其他页面已切换账号，请刷新后继续学习')
        return false
      }
    } catch { /* The normal durable write below reports unavailable storage. */ }
  }
  state.value = next
  try {
    // Preserve unreadable records before a fresh state can replace them.
    if (recoverySnapshot.value && !recoveryPersisted) {
      localStorage.setItem(RECOVERY_STORAGE, recoverySnapshot.value)
      recoveryPersisted = true
    }
    let previous=null
    try{previous=JSON.parse(localStorage.getItem(STORAGE) || 'null')}catch{}
    const marker=applicationId===undefined ? previous?._cloudAppliedId : applicationId
    localStorage.setItem(STORAGE, JSON.stringify(marker ? {...next,_cloudAppliedId:marker} : next)); storageAvailable.value = true
    if (!fromCloud) cloud?.schedule()
    return true
  }
  catch { storageAvailable.value = false; notify('本地保存失败，请导出备份并检查存储权限或空间'); return false }
}
const now = ref(Date.now())
const timer = setInterval(() => { now.value = Date.now() }, 30000)
onBeforeUnmount(() => { clearInterval(timer); clearTimeout(toastTimer) })
const stats = computed(() => core.getStats(state.value, now.value))
const activeBook = computed(() => books.find(b => b.id === state.value.bookId) || books[0])
const learningOrders = core.LEARNING_ORDERS
function orderInfo(id) { return learningOrders.find(order => order.id === id) || learningOrders[0] }
const selectedOrder = computed(() => orderInfo(state.value.settings.learningOrder))
const navigation = [ {id:'home',label:'今日学习',short:'学习',icon:'home'}, {id:'books',label:'发现词书',short:'词书',icon:'book'}, {id:'collection',label:'我的词集',short:'词集',icon:'layers'}, {id:'memory',label:'记忆足迹',short:'记忆',icon:'chart'} ]
function navigate(id) { page.value = id; location.hash = id; window.scrollTo({top:0,behavior:'instant'}) }
const onHashChange = () => { page.value = location.hash.slice(1) || 'home' }
window.addEventListener('hashchange', onHashChange)
onBeforeUnmount(() => { window.removeEventListener('hashchange', onHashChange); window.speechSynthesis?.cancel() })
const dateLabel = computed(() => new Intl.DateTimeFormat('zh-CN',{month:'long',day:'numeric',weekday:'long'}).format(new Date(now.value)))
const greeting = computed(() => new Date(now.value).getHours() < 12 ? '早上好，慢慢来，也很快。' : new Date(now.value).getHours() < 18 ? '下午好，让记忆轻一点。' : '晚上好，留一点时间给自己。')
const settingOpen = ref(false)
const tutorialStep = ref(0)
const tutorialOpen = ref(!state.value.settings.tutorialComplete)
try { tutorialOpen.value = tutorialOpen.value && !localStorage.getItem('oneword.tutorial') } catch {}
const tutorials = [ {title:'一个词，先记一个意思',text:'把注意力留给最常用的核心义。需要更多时，轻点展开释义和例句。',icon:'leaf'}, {title:'轻轻一滑，记下真实感受',text:'左滑「不认识」，右滑「认识」。似懂非懂就点「不确定」，不用勉强自己。',icon:'layers'}, {title:'在快忘记的时候，再见一面',text:'先复习到期词，再学新词。间隔随每次反馈调整，记住比学完更重要。',icon:'clock'} ]
function closeTutorial() { tutorialOpen.value = false; tutorialStep.value = 0; save(core.updateSettings(state.value, {tutorialComplete:true})); try { localStorage.setItem('oneword.tutorial','1') } catch {} }
const bookCategory = ref('全部')
const bookSearch = ref('')
const downloadingBook = ref('')
const catalogRevision = ref(0)
try {
  cloud = connectCloud({
    getState: () => {
      // Tabs share durable progress. Read it again while holding the sync lock,
      // so an older tab cannot submit the same answer as another local delta.
      const saved=localStorage.getItem(STORAGE)
      if(saved){
        const raw=JSON.parse(saved)
        const {_cloudAppliedId,...plain}=raw
        if(JSON.stringify({...plain,history:[]})!==JSON.stringify({...state.value,history:[]})){
          state.value=core.restoreState(raw);lastRating=null
        }
      }
      return state.value
    },
    getAppliedId: () => JSON.parse(localStorage.getItem(STORAGE) || 'null')?._cloudAppliedId || null,
    setState(next,applicationId) {
      const unchanged=JSON.stringify({...state.value,history:[]})===JSON.stringify({...next,history:[]})
      if(unchanged) next={...next,history:state.value.history}
      if (!save(next,true,applicationId)) throw Error('本机保存失败，云端记录仍保留，请释放存储空间后重试')
      // A merged snapshot has no usable local undo history.
      if(!unchanged) lastRating = null
    },
    onCatalog: () => {catalogRevision.value++},
    onChange: next => {
      const changed=(cloudStatus.value.user?.id || null)!==(next.user?.id || null)
      cloudStatus.value=next
      if(changed){session.value=[];sessionIndex.value=0;sessionDone.value=false;lastRating=null;navigate('home')}
    }
  })
  cloudStatus.value=cloud.getStatus()
} catch { /* Guest learning remains available when local storage is blocked. */ }
function syncWhenVisible() { if (!document.hidden) cloud?.init() }
function syncOnFocus() { cloud?.sync() }
function onCloudIdentityChange(event) {
  if(event.key==='oneword.cloud.identity.v1'){location.reload();return}
  if(event.key===STORAGE && event.newValue){
    try{state.value=core.restoreState(event.newValue);lastRating=null}
    catch{location.reload()}
  }
}
onMounted(() => {
  cloud?.init()
  window.addEventListener('online',syncWhenVisible)
  window.addEventListener('focus',syncOnFocus)
  document.addEventListener('visibilitychange',syncWhenVisible)
  window.addEventListener('storage',onCloudIdentityChange)
})
const cloudTimer=setInterval(()=>{if(!document.hidden)cloud?.sync()},60000)
onBeforeUnmount(()=>{
  clearInterval(cloudTimer);cloud?.destroy()
  window.removeEventListener('online',syncWhenVisible)
  window.removeEventListener('focus',syncOnFocus)
  document.removeEventListener('visibilitychange',syncWhenVisible)
  window.removeEventListener('storage',onCloudIdentityChange)
})
const fullBookOpen = ref(null)
const bookMetadata = ref({})
let metadataRequest
onMounted(async () => {
  metadataRequest = new AbortController()
  const timeout = setTimeout(() => metadataRequest.abort(), 8000)
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}api/books`, {signal:metadataRequest.signal})
    if (response.ok) {
      const data = await response.json()
      if (Array.isArray(data.books)) bookMetadata.value = Object.fromEntries(data.books.filter(book => books.some(item => item.id === book.id)).map(book => [book.id,book]))
    }
  } catch { /* The built-in selected vocabulary is available without a network. */ }
  finally { clearTimeout(timeout) }
})
onBeforeUnmount(() => metadataRequest?.abort())
function fullCount(book) { return bookMetadata.value[book.id]?.fullCount || (isFullBook(book) ? book.count : null) }
async function getFullBook(book) {
  if (downloadingBook.value) return
  downloadingBook.value = book.id
  try {await downloadBook(book.id); catalogRevision.value++; const persisted = save(core.setBook(state.value,book.id)); fullBookOpen.value=null; notify(persisted ? '完整词库已保存，可以离线学习了' : '词库已缓存，但学习记录保存失败，请导出备份'); navigate('home')} catch(error) {notify(error.message || '下载失败，请稍后重试')} finally {downloadingBook.value=''}
}
function isFullBook(book) {catalogRevision.value;return installedBooks().includes(book.id)}
const categories = computed(() => ['全部', ...new Set(books.map(b => b.category))])
const filteredBooks = computed(() => books.filter(b => (bookCategory.value === '全部' || b.category === bookCategory.value) && `${b.title} ${b.subtitle} ${b.id}`.toLowerCase().includes(bookSearch.value.toLowerCase())))
function selectBook(book) { if (!book.available) return notify('这本词书还在整理，先选一本已经准备好的吧'); save(core.setBook(state.value,book.id)); notify(`已切换到${book.title}，已有进度会保留`); navigate('home') }
const collectionTab = ref('unknown')
const collectionSearch = ref('')
const collection = computed(() => core.getCollection(state.value, collectionTab.value).filter(w => `${w.word} ${w.coreMeaning}`.toLowerCase().includes(collectionSearch.value.toLowerCase())))
const collectionLabels = {unknown:'不认识',unsure:'不确定',known:'认识'}
const detail = ref(null)
function openWord(word) { detail.value = word }
function moveToLearning(word) { const next = core.rateWord(state.value, word.id, 'unknown', Date.now()); if (next === state.value) return notify('刚记录过这个词，请稍等一下'); save(next); detail.value = null; notify('已放回不认识词集，稍后安排复习') }
const session = ref([])
const sessionIndex = ref(0)
const sessionMode = ref('today')
const sessionLearningOrder = ref(state.value.settings.learningOrder || 'adaptive')
const sessionOrder = computed(() => orderInfo(sessionLearningOrder.value))
const sessionDone = ref(false)
const sessionStart = ref(0)
const sessionResults = ref({known:0,unknown:0,unsure:0})
const revealed = ref(true)
const expanded = ref(false)
const currentWord = computed(() => session.value[sessionIndex.value])
const sessionTotal = computed(() => session.value.length)
const sessionPercent = computed(() => sessionTotal.value ? Math.round(sessionIndex.value/sessionTotal.value*100) : 0)
function startSession(mode='today') {
  now.value = Date.now()
  const queue = core.makeSession(state.value,{mode,now:now.value,limit:60})
  if (!queue.length) return notify(mode === 'review' ? '当前没有到期词，休息一下也很好' : '今天的计划已完成，稍后再来复习吧')
  session.value = queue; sessionIndex.value = 0; sessionMode.value = mode; sessionLearningOrder.value = state.value.settings.learningOrder || 'adaptive'; sessionDone.value = false; sessionStart.value = Date.now(); sessionResults.value = {known:0,unknown:0,unsure:0}; lastRating = null
  resetCard(); navigate('study')
}
function resetCard() { revealed.value = !state.value.settings.recallFirst; expanded.value = false; dragX.value = 0 }
const ratingBusy = ref(false)
function rate(rating) {
  if (!currentWord.value || !revealed.value || ratingBusy.value || sessionDone.value) return
  ratingBusy.value = true
  try {
    const next = core.rateWord(state.value, currentWord.value.id, rating, Date.now())
    if (next === state.value) return notify('刚记录过这个词，请稍等一下')
    save(next)
    lastRating = rating; sessionResults.value[rating]++; sessionIndex.value++; now.value = Date.now()
    if (sessionIndex.value >= sessionTotal.value) sessionDone.value = true
    else resetCard()
  } catch (error) { notify(error.message || '记录失败，请重试') }
  finally { setTimeout(() => { ratingBusy.value = false }, 180) }
}
function undo() {
  if (!lastRating || sessionIndex.value < 1) return
  save(core.undo(state.value)); sessionResults.value[lastRating]--; sessionIndex.value--; sessionDone.value = false; lastRating = null; resetCard(); notify('已撤销上一次判断')
}
const dragX = ref(0)
let dragStart = null
function pointerDown(event) { if (event.target.closest('button,a,input') || expanded.value || !revealed.value) return; dragStart = {x:event.clientX,y:event.clientY}; event.currentTarget.setPointerCapture?.(event.pointerId) }
function pointerMove(event) { if (!dragStart) return; if (Math.abs(event.clientY-dragStart.y) > Math.abs(event.clientX-dragStart.x)+15) {dragStart = null;dragX.value=0;return}; dragX.value = Math.max(-160,Math.min(160,event.clientX-dragStart.x)) }
function pointerUp() { if (!dragStart) return; const distance = dragX.value; dragStart = null; dragX.value=0; if (distance > 85) rate('known'); else if (distance < -85) rate('unknown') }
function pronounce(word) {
  if (!('speechSynthesis' in window)) return notify('当前设备暂不支持朗读，可以先看音标')
  speechSynthesis.cancel(); const speech = new SpeechSynthesisUtterance(word.word); speech.lang = state.value.settings.accent === 'uk' ? 'en-GB' : 'en-US'; speech.rate = .82; speech.onerror = event => { if (!['canceled','interrupted'].includes(event.error)) notify('当前设备无法播放朗读，可以先看音标') }; speechSynthesis.speak(speech)
}
function resizeActiveSession() {
  now.value = Date.now()
  const current = state.value
  const bookIds = new Set(activeBook.value.wordIds)
  const pending = session.value.slice(sessionIndex.value).filter(word => bookIds.has(word.id))
  const options = {now:now.value,limit:200,learningOrder:sessionLearningOrder.value}
  const joinUnique = (first,rest) => {
    const seen = new Set()
    return first.concat(rest).filter(word => {if (seen.has(word.id)) return false; seen.add(word.id); return true})
  }
  // Keep the pending order when a goal changes, including across local midnight.
  // Newly due reviews may move ahead of new words, but a new day's random seed
  // must not reshuffle words already chosen for this group.
  const pendingDue = pending.filter(word => current.words[word.id]?.dueAt <= now.value)
  const pendingNew = pending.filter(word => !current.words[word.id])
  const due = sessionMode.value === 'new' ? [] : joinUnique(pendingDue,core.makeSession(current,{...options,mode:'review'}))
  const room = core.getStats(current,now.value).remainingNew
  const fresh = sessionMode.value === 'review' ? [] : joinUnique(pendingNew,core.makeSession(current,{...options,mode:'new'})).slice(0,room)
  const remaining = due.concat(fresh).slice(0,60)
  session.value = session.value.slice(0,sessionIndex.value).concat(remaining)
  sessionDone.value = sessionIndex.value >= session.value.length
  if (!sessionDone.value) resetCard()
}
function changeSetting(key,value) {
  try {
    const persisted = save(core.updateSettings(state.value,{[key]:value}))
    if (page.value === 'study' && !sessionDone.value) {
      if (key === 'dailyGoal' && ['today','new','review'].includes(sessionMode.value)) {
        resizeActiveSession()
      } else if (key === 'recallFirst') resetCard()
    }
    if (persisted) notify(key === 'learningOrder' ? '学习顺序已保存，从下一组开始生效' : '设置已保存')
  } catch(error) {notify(error.message)}
}
function exportData() {
  const blob = new Blob([JSON.stringify({format:'oneword.backup',version:1,product:'oneword',exportedAt:new Date().toISOString(),bookIds:installedBooks(),state:state.value},null,2)],{type:'application/json'})
  const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href=url; a.download=`oneword-${new Date().toISOString().slice(0,10)}.json`; a.click(); setTimeout(()=>URL.revokeObjectURL(url),5000); notify('备份已导出，请妥善保存')
}
function exportRecovery() {
  if (!recoverySnapshot.value) return
  const blob = new Blob([recoverySnapshot.value], {type:'application/json'})
  const url = URL.createObjectURL(blob); const a = document.createElement('a')
  a.href = url; a.download = 'oneword-original-record.json'; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
  notify('已导出原始记录，请保留以便排查恢复')
}
const importingBackup = ref(false)
async function importData(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file || importingBackup.value) return
  if (file.size > 5*1024*1024) return notify('备份文件不能超过 5 MB')
  importingBackup.value = true
  try {
    const parsed=JSON.parse(await file.text())
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw Error('备份格式不正确，请选择一词导出的 JSON 文件')
    if (parsed.format && (parsed.format !== 'oneword.backup' || parsed.version !== 1)) throw Error('暂不支持这个备份版本，请使用一词导出的备份')
    await restoreBookManifest(parsed.bookIds || parsed.catalogBooks)
    catalogRevision.value++
    const restored=core.restoreState(parsed.state || parsed)
    if (!window.confirm('恢复会覆盖当前设备的学习进度，是否继续？')) return
    const persisted = save(restored)
    session.value=[]; sessionIndex.value=0; sessionDone.value=false; lastRating=null
    settingOpen.value=false; now.value=Date.now(); navigate('home')
    notify(persisted ? '已恢复学习进度' : '已读取备份，但本机保存失败，请保留备份文件')
  } catch(error) {
    catalogRevision.value++
    notify(error instanceof SyntaxError ? '备份不是有效的 JSON 文件，请重新选择' : error.message || '恢复失败，请保留原备份后重试')
  } finally { importingBackup.value=false }
}
const nextReviewHint = computed(() => {
  if (stats.value.dueCount) return `还有 ${stats.value.dueCount} 个到期词，可以继续复习。`
  const due = stats.value.nextDueAt
  if (!due) return '新的复习安排，会在每次学习后出现。'
  const minutes = Math.max(1,Math.ceil((due-now.value)/60000))
  if (minutes < 60) return `约 ${minutes} 分钟后，再来复习一次。`
  return `下次复习：${new Date(due).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}`
})
const learnedWords = computed(() => Object.keys(state.value.words || {}).length)
const weekMax = computed(() => Math.max(5,...stats.value.last7Days.map(d=>d.newCount+d.reviewCount)))
const sessionMinutes = computed(() => Math.max(1,Math.round((Date.now()-sessionStart.value)/60000)))
function progressForBook(book) { const count=book.wordIds.filter(id=>state.value.words[id]).length; return {count,percent:book.count ? Math.round(count/book.count*100):0} }
const seedWord = computed(() => wordMap['serendipity'] || words.find(w=>w.word==='serendipity') || words.find(w=>w.word==='journey') || words[0])
const dialogOpen = computed(() => tutorialOpen.value || settingOpen.value || !!detail.value || !!fullBookOpen.value)
let returnFocus = null
let previousOverflow = ''
function currentDialog() { return [...document.querySelectorAll('[role=dialog]')].at(-1) }
function dialogControls(dialog) { return [...dialog.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), [tabindex="0"]')].filter(element => element.getClientRects().length) }
watch([tutorialOpen,settingOpen,detail,fullBookOpen], async (values,previous=[]) => {
  const open = values.some(Boolean)
  if (open && !previous.some(Boolean)) { returnFocus = document.activeElement; previousOverflow = document.body.style.overflow; document.body.style.overflow='hidden' }
  await nextTick()
  if (open) { const dialog=currentDialog(); if (dialog) dialogControls(dialog)[0]?.focus({preventScroll:true}) }
  else { document.body.style.overflow=previousOverflow; if (returnFocus?.isConnected) returnFocus.focus({preventScroll:true}); returnFocus=null }
}, {immediate:true,flush:'post'})
function onDialogKey(event) {
  if (!dialogOpen.value) return
  if (event.key === 'Escape') {
    event.preventDefault()
    if (detail.value) detail.value=null
    else if (settingOpen.value) settingOpen.value=false
    else if (tutorialOpen.value) closeTutorial()
    else if (!downloadingBook.value) fullBookOpen.value=null
  } else if (event.key === 'Tab') {
    const dialog=currentDialog(); if (!dialog) return
    const controls=dialogControls(dialog); const first=controls[0]; const last=controls.at(-1)
    if (!first) {event.preventDefault();return}
    if (event.shiftKey && (document.activeElement===first || !dialog.contains(document.activeElement))) {event.preventDefault();last.focus()}
    else if (!event.shiftKey && (document.activeElement===last || !dialog.contains(document.activeElement))) {event.preventDefault();first.focus()}
  }
}
document.addEventListener('keydown',onDialogKey)
onBeforeUnmount(() => {document.removeEventListener('keydown',onDialogKey);document.body.style.overflow=previousOverflow})
</script>

<template>
  <div class="app-shell" :class="{'is-studying':page==='study'}">
    <aside class="sidebar" :inert="dialogOpen || undefined">
      <a href="#home" class="brand" @click.prevent="navigate('home')"><span class="brand-symbol"><Icon name="leaf" :size="27" /></span><span>一词<span class="brand-en">ONEWORD</span></span></a>
      <div class="sidebar-caption">让记忆，轻一点。</div>
      <nav class="desktop-nav" aria-label="主导航"><button v-for="item in navigation" :key="item.id" :class="{active:page===item.id}" @click="navigate(item.id)"><Icon :name="item.icon"/><span>{{item.label}}</span><span v-if="item.id==='home'" class="nav-dot"></span></button></nav>
      <div class="sidebar-note"><span class="tiny-label">A LITTLE, EVERY DAY</span><p>不必一次记住所有。<br>每次，记住一点就好。</p><div class="note-sprout"><Icon name="leaf" :size="42"/></div></div>
      <button class="sidebar-settings" @click="settingOpen=true"><Icon name="settings" :size="20"/><span>学习设置</span></button>
      <div class="sidebar-footer">慢一点，也在向前。<span>v1.0 · LOCAL FIRST</span></div>
    </aside>
    <main class="main" :inert="dialogOpen || undefined">
      <template v-if="page!=='study'">
        <header class="topbar"><a class="mobile-brand" href="#home"><Icon name="leaf" :size="23"/><b>一词</b></a><span class="topbar-date">{{dateLabel}}</span><div class="topbar-right"><span class="streak-pill"><Icon name="sun" :size="16"/>{{stats.streak ? `连续学习 ${stats.streak} 天` : '从今天，开始积累'}}</span><button class="cloud-entry" aria-label="打开账号与同步" @click="settingOpen=true">{{cloudStatus.user ? cloudStatus.user.username.slice(0,1).toUpperCase() : '登录'}}</button><button class="avatar" aria-label="打开学习设置" @click="settingOpen=true">{{stats.streak ? stats.streak : '词'}}</button></div></header>
        <div v-if="!storageAvailable || recoverySnapshot" class="storage-warning">{{recoverySnapshot ? '旧记录暂时无法读取，原内容已保留，请先导出以便恢复。' : '本地记录暂时无法读取或保存。请先导出备份，并检查浏览器存储设置。'}}<button v-if="recoverySnapshot" @click="exportRecovery">导出原记录</button><button v-else @click="exportData">导出备份</button></div>
      </template>

      <div v-if="page==='home'" class="page home-page">
        <div class="page-heading"><div><p class="eyebrow">TODAY, ONE WORD AT A TIME</p><h1>每次，只记<span class="serif-accent">一个</span>意思。</h1><p class="subtitle">{{greeting}}</p></div><button class="text-button heading-tip" @click="tutorialOpen=true; tutorialStep=0"><Icon name="help" :size="17"/>使用指南</button></div>
        <section class="hero">
          <div class="hero-copy"><div class="hero-kicker"><span class="live-dot"></span>今日学习计划<span class="hero-divider">/</span>{{activeBook.title}}</div><h2>小小的一词，<br>大大的一步<span class="lime">。</span></h2><p>只关注眼前的词，剩下的交给时间。</p><button class="primary-button lime-button" @click="startSession()">{{stats.todayAnswers ? '继续今日学习' : '开始今日学习'}}<Icon name="arrow" :size="21"/></button><div class="hero-foot">{{stats.todayRemaining ? `今日还可学 ${stats.remainingNew} 个新词 · ${stats.dueCount} 个词待复习` : nextReviewHint}}</div></div>
          <div class="hero-art" aria-hidden="true"><svg viewBox="0 0 330 310"><defs><pattern id="lines" width="13" height="13" patternUnits="userSpaceOnUse"><path d="M0 13 13 0" stroke="#e9ef9c" stroke-width="1" opacity=".17"/></pattern></defs><circle cx="168" cy="151" r="129" fill="none" stroke="#b5c8a1" stroke-opacity=".22"/><circle cx="168" cy="151" r="102" fill="none" stroke="#b5c8a1" stroke-opacity=".3"/><circle cx="168" cy="151" r="74" fill="none" stroke="#b5c8a1" stroke-opacity=".2"/><path d="M158 243C60 233 51 107 194 64c36 108 5 160-36 179Z" fill="#e9ef9c"/><path d="m124 253 50-136" stroke="#244d3d" stroke-width="2"/><path d="M174 198C217 123 310 158 267 246c-55 3-83-13-93-48Z" fill="#a7b991"/><path d="m163 239 79-41" stroke="#244d3d" stroke-width="2"/><path d="M158 243C60 233 51 107 194 64c36 108 5 160-36 179Z" fill="url(#lines)"/><circle cx="71" cy="68" r="4" fill="#e9ef9c"/><path d="m269 67 0 20m-10-10h20" stroke="#e9ef9c" stroke-width="1.5"/></svg><div class="art-caption">GROW AT YOUR OWN PACE</div></div>
        </section>
        <button class="learning-order-entry" aria-label="选择学习顺序" @click="settingOpen=true"><span><Icon name="layers" :size="18"/><span>学习顺序 <b>{{selectedOrder.label}}</b></span></span><span>切换顺序<Icon name="down" :size="15"/></span></button>
        <section class="daily-stats" aria-label="今日进度"><div><span class="stat-label"><span class="stat-mark green"></span>今日新学</span><div><b>{{stats.todayNew}}</b><span>/ {{stats.dailyGoal}} 词</span></div><div class="mini-progress"><i :style="{width:Math.min(100,stats.todayNew/stats.dailyGoal*100)+'%'}"></i></div></div><div><span class="stat-label"><span class="stat-mark apricot"></span>到期复习</span><div><b>{{stats.dueCount}}</b><span>词等你再见</span></div><button class="stat-link" @click="startSession('review')">{{stats.dueCount ? '趁还记得，再见一次' : '暂无到期，轻松一点'}}<Icon name="arrow" :size="15"/></button></div><div><span class="stat-label"><span class="stat-mark sage"></span>累计相遇</span><div><b>{{learnedWords}}</b><span>个单词</span></div><span class="stat-caption">每一词，都是你的积累</span></div></section>
        <div class="home-lower"><section class="current-book section-card"><div class="section-top"><h3>正在学习</h3><button class="text-button" @click="navigate('books')">换本词书<Icon name="arrow" :size="16"/></button></div><div class="current-book-content"><div class="book-cover small-cover" :style="{'--cover':activeBook.coverColor || '#d9dfbe'}"><span>ONEWORD<br>SELECTED</span><b>{{activeBook.title}}</b><small>一词 · 精选词库</small><div class="cover-lines"></div></div><div class="book-summary"><span class="tag">{{isFullBook(activeBook)?'完整词库':'精选核心词'}}</span><h4>{{activeBook.title}}</h4><p>{{activeBook.count}} 词 · {{isFullBook(activeBook)?'已离线保存':'离线精选，轻量开始'}}</p><div class="book-progress-label"><span>已相遇 {{stats.learnedCount}} 词</span><b>{{Math.round(stats.progress)}}%</b></div><div class="mini-progress"><i :style="{width:stats.progress+'%'}"></i></div><button v-if="!isFullBook(activeBook)" class="download-inline text-button" @click="fullBookOpen=activeBook"><Icon name="download" :size="13"/>获取完整词库</button></div></div></section>
        <section class="word-of-day section-card"><span class="tiny-label">A WORD TO KEEP</span><span class="word-number">01 / 慢慢记</span><h3>{{seedWord.word}}</h3><p>{{seedWord.pos}} <span>{{seedWord.coreMeaning}}</span></p><div class="word-day-bottom"><span>好的相遇，值得记住。</span><button class="round-button" aria-label="朗读每日单词" @click="pronounce(seedWord)"><Icon name="sound" :size="18"/></button></div></section></div>
        <div class="gentle-note"><Icon name="shield" :size="16"/><span>{{cloudStatus.user ? cloudStatus.message : '游客可直接学习；登录后可在不同设备继续。'}}</span></div><AccountPanel v-if="cloud" :client="cloud" :status="cloudStatus" />
      </div>

      <div v-else-if="page==='books'" class="page books-page"><div class="page-heading"><div><p class="eyebrow">FIND YOUR NEXT CHAPTER</p><h1>选一本，慢慢记。</h1><p class="subtitle">从课堂到更远的世界，总有适合你的起点。</p></div></div><div class="library-toolbar"><div class="filter-tabs"><button v-for="category in categories" :class="{selected:bookCategory===category}" @click="bookCategory=category">{{category}}</button></div><label class="search"><Icon name="search" :size="19"/><input v-model="bookSearch" aria-label="搜索词书" placeholder="搜索词书"/></label></div><p class="library-note">内置离线精选，也可下载完整源标签词库。实际收录数量如实展示，不同词书的学习进度互通。</p><div class="book-grid"><article v-for="book in filteredBooks" :key="book.id" class="book-item" tabindex="0" role="button" @keydown.enter="selectBook(book)" :class="{chosen:state.bookId===book.id,unavailable:!book.available}" @click="selectBook(book)"><div class="book-cover" :style="{'--cover':book.coverColor || '#d8dfc8'}"><span>ONEWORD<br>VOCABULARY</span><b>{{book.title}}</b><span class="cover-subtitle">{{book.subtitle}}</span><div class="cover-lines"></div><small>{{String(books.indexOf(book)+1).padStart(2,'0')}} / 每次记一点</small><span v-if="state.bookId===book.id" class="cover-selected"><Icon name="check" :size="15"/>在学</span></div><div class="book-item-info"><h3>{{book.title}}</h3><span>{{book.available ? `${book.count} 词 · ${isFullBook(book)?'完整已缓存':'离线精选'}` : '整理中'}}</span><span v-if="book.available && !isFullBook(book) && fullCount(book)" class="full-book-count">完整版 {{fullCount(book)}} 词</span><div v-if="progressForBook(book).count" class="mini-progress"><i :style="{width:progressForBook(book).percent+'%'}"></i></div><button v-if="book.available && !isFullBook(book)" class="book-download text-button" @click.stop="fullBookOpen=book"><Icon name="download" :size="13"/>下载完整词库</button></div></article></div><div v-if="!filteredBooks.length" class="empty-state"><Icon name="search" :size="36"/><h3>还没找到这本词书</h3><p>试试“四级”“高中”或其他关键词。</p><button class="text-button" @click="bookSearch='';bookCategory='全部'">查看全部词书</button></div></div>

      <div v-else-if="page==='collection'" class="page collection-page"><div class="page-heading"><div><p class="eyebrow">EVERY WORD HAS ITS PLACE</p><h1>每一次相遇，都算数。</h1><p class="subtitle">不认识、不确定、认识，都只是记忆的一个阶段。</p></div></div><div class="collection-summary"><button v-for="(label,status) in collectionLabels" :class="['collection-category',status,{selected:collectionTab===status}]" @click="collectionTab=status"><span class="category-icon"><Icon :name="status==='known'?'check':status==='unknown'?'close':'unsure'"/></span><span>{{label}}<b>{{stats[status+'Count']}}</b></span><Icon name="arrow" :size="19"/></button></div><div class="section-top collection-top"><div><h3>{{collectionLabels[collectionTab]}}的词 <span class="muted-count">{{collection.length}}</span></h3><p>{{collectionTab==='known'?'熟悉还需要时间，会继续为你安排复习。':collectionTab==='unknown'?'没关系，下一次相见会更熟悉一点。':'诚实地保留一点不确定，记忆会更牢固。'}}</p></div><label class="search"><Icon name="search" :size="19"/><input v-model="collectionSearch" aria-label="搜索词集" placeholder="搜索单词或释义"/></label></div><div v-if="collection.length" class="word-list"><button v-for="word in collection" :key="word.id" class="word-row" @click="openWord(word)"><span><b>{{word.word}}</b><small>{{word.phonetic}}</small></span><span class="row-meaning"><small>{{word.pos}}</small>{{word.coreMeaning}}</span><Icon name="arrow" :size="18"/></button></div><div v-else class="empty-state"><span class="empty-leaf"><Icon name="leaf" :size="42"/></span><h3>{{collectionSearch ? '没有匹配的单词' : '这里的故事，等你开始'}}</h3><p>{{collectionSearch ? '换一个单词或中文释义试试。' : '每次判断都会自动整理到这里，随时可以回来看看。'}}</p><button v-if="!collectionSearch" class="primary-button" @click="startSession()">去学几个词<Icon name="arrow" :size="18"/></button></div><button v-if="collection.length" class="primary-button collection-practice" @click="startSession(collectionTab)">练习这组词<Icon name="arrow" :size="18"/></button></div>

      <div v-else-if="page==='memory'" class="page memory-page"><div class="page-heading"><div><p class="eyebrow">SMALL STEPS, LASTING MEMORIES</p><h1>时间，会记得你的努力。</h1><p class="subtitle">学习不是一条直线，每一次回想，都在让记忆扎根。</p></div><button class="text-button" @click="settingOpen=true"><Icon name="settings" :size="18"/>学习设置</button></div><div class="memory-numbers"><div><span>累计相遇</span><b>{{learnedWords}}<small>词</small></b></div><div><span>连续学习</span><b>{{stats.streak}}<small>天</small></b></div><div><span>稳定记忆</span><b>{{stats.masteredCount}}<small>词</small></b></div></div><section class="section-card week-card"><div class="section-top"><div><h3>这一周，一点一点</h3><p>每日新学与复习的去重词数</p></div><span class="legend"><i></i>新学<i></i>复习</span></div><div class="bar-chart"><div v-for="day in stats.last7Days" :key="day.date" class="chart-day"><b>{{day.newCount + day.reviewCount || ''}}</b><div class="chart-bar-stack"><i :style="{height:(day.reviewCount/weekMax*130)+'px'}"></i><i :style="{height:(day.newCount/weekMax*130)+'px'}"></i></div><span>{{day.label}}</span></div></div></section><div class="memory-bottom"><section class="section-card forecast"><div class="section-top"><h3>接下来，再见面</h3><Icon name="clock" :size="21"/></div><p>计划根据你的反馈动态调整，不必追赶。</p><div v-for="day in stats.forecast.slice(0,5)" :key="day.date" class="forecast-row"><span>{{day.label}}</span><div><i :style="{width:Math.min(100,day.count*5)+'%'}"></i></div><b>{{day.count}}<small>词</small></b></div><p v-if="!learnedWords" class="forecast-empty">学完第一组词，这里就会出现复习安排。</p></section><section class="section-card science-card"><span class="tiny-label">THE ART OF REMEMBERING</span><h3>记忆需要间隔，<br>也需要一次次想起。</h3><p>参考间隔学习与主动回忆研究，从 5 分钟或 15 分钟后的重学，到 {{core.INTERVALS.join('、')}} 天的间隔，按你的真实反馈逐步调整。</p><span class="science-foot">稳定记忆：按间隔计划至少 4 次认识，且间隔 ≥ 7 天；为计划指标，不代表永不遗忘。</span></section></div><div class="gentle-note"><Icon name="shield" :size="16"/><span>所有数字来自当前设备的真实记录。建议定期导出备份。</span><button class="text-button" @click="exportData">导出</button></div></div>

      <div v-else-if="page==='study'" class="study-page"><header class="study-header"><button class="round-button" aria-label="退出学习" @click="navigate('home')"><Icon name="close"/></button><div><span>{{activeBook.title}}</span><b>{{sessionDone?'今日这一组，完成了':`${sessionIndex+1} / ${sessionTotal}`}}</b></div><button class="round-button" aria-label="学习设置" @click="settingOpen=true"><Icon name="settings" :size="20"/></button></header><div class="study-progress"><i :style="{width:(sessionDone?100:sessionPercent)+'%'}"></i></div><template v-if="!sessionDone && currentWord"><div class="study-context"><div class="study-context-info"><span><i></i>{{state.words[currentWord.id]?'复习 · 让记忆更牢固':'新词 · 初次相遇'}}</span><span class="study-order-label">{{sessionOrder.label}}</span></div><button class="text-button" :disabled="!lastRating" @click="undo"><Icon name="undo" :size="16"/>撤销</button></div><div class="study-card" :style="{transform:`translateX(${dragX}px) rotate(${dragX/28}deg)`}" @pointerdown="pointerDown" @pointermove="pointerMove" @pointerup="pointerUp" @pointercancel="dragStart=null;dragX=0"><span v-if="dragX < -40 || dragX > 40" class="swipe-label" :class="dragX>0?'known':'unknown'">{{dragX>0?'认识':'不认识'}}</span><span class="tiny-label card-kicker">ONE WORD. ONE MEANING.</span><div class="word-title"><h1>{{currentWord.word}}</h1><button class="round-button word-sound" aria-label="朗读单词" @click="pronounce(currentWord)"><Icon name="sound" :size="22"/></button></div><p class="phonetic">{{currentWord.phonetic || '轻点发音，听一听'}} <span>{{state.settings.accent==='uk'?'英音朗读':'美音朗读'}}</span></p><div v-if="revealed" class="core-meaning"><span>{{currentWord.pos}}</span><h2>{{currentWord.coreMeaning}}</h2></div><button v-else class="reveal-button" @click="revealed=true"><Icon name="spark" :size="22"/>先回想一下，再点开核心义</button><button v-if="revealed" class="expand-button" :aria-expanded="expanded" @click="expanded=!expanded">{{expanded?'收起更多释义':'更多释义与例句'}}<Icon name="down" :size="15" :class="{rotated:expanded}"/></button><div v-if="expanded && revealed" class="expanded-meaning"><div v-for="(meaning,index) in currentWord.meanings" :key="index"><small>{{meaning.pos}}</small><span>{{meaning.meaning}}</span></div><blockquote v-if="currentWord.example"><p>{{currentWord.example.en}}</p><span>{{currentWord.example.zh}}</span></blockquote><p class="meaning-hint">先记核心义就好，其他意思以后慢慢熟悉。</p></div><span class="card-footnote">把注意力，留给一个意思。</span></div><div class="rating-area"><p class="rating-instruction">{{revealed?'这个词，你认识吗？如实判断就好。':'试着在心里回想它的意思。'}}</p><div class="rating-buttons"><button class="rating unknown" :disabled="!revealed||ratingBusy" @click="rate('unknown')"><span><Icon name="close" :size="27"/></span><b>不认识</b><small>← 左滑</small></button><button class="rating unsure" :disabled="!revealed||ratingBusy" @click="rate('unsure')"><span><Icon name="unsure" :size="27"/></span><b>不确定</b><small>再见一次</small></button><button class="rating known" :disabled="!revealed||ratingBusy" @click="rate('known')"><span><Icon name="check" :size="27"/></span><b>认识</b><small>右滑 →</small></button></div><span class="study-gentle">认识不等于永远记住，我们会在合适的时候提醒你复习。</span></div></template><div v-else-if="sessionDone" class="session-complete"><span class="complete-emblem"><Icon name="leaf" :size="55"/></span><p class="eyebrow">A LITTLE PROGRESS, EVERY DAY</p><h1>又向前了一小步。</h1><p>这 {{sessionTotal}} 次相遇，会慢慢变成你的记忆。</p><div class="complete-stats"><div><b>{{sessionResults.known}}</b><span>认识</span></div><div><b>{{sessionResults.unsure}}</b><span>不确定</span></div><div><b>{{sessionResults.unknown}}</b><span>不认识</span></div></div><span class="complete-time">专注约 {{sessionMinutes}} 分钟 · 复习计划已更新</span><p class="complete-next">{{nextReviewHint}}</p><button class="primary-button" @click="navigate('home')">收下今天的进步<Icon name="arrow" :size="19"/></button><button class="text-button" :disabled="!lastRating" @click="undo"><Icon name="undo" :size="16"/>撤销最后一次判断</button></div><div v-else class="empty-state"><h3>准备好，就从一个词开始。</h3><button class="primary-button" @click="navigate('home')">回到今日学习</button></div></div>
      <div v-else class="empty-state"><h1>这一页还没有单词</h1><button class="primary-button" @click="navigate('home')">返回学习首页</button></div>
      <footer v-if="page!=='study'" class="page-footer"><span>一词 ONEWORD</span><span>少一点负担，多一点记住。</span><button @click="settingOpen=true">设置与数据</button></footer>
    </main>
    <nav v-if="page!=='study'" :inert="dialogOpen || undefined" class="mobile-nav" aria-label="主导航"><button v-for="item in navigation" :key="item.id" :class="{active:page===item.id}" @click="navigate(item.id)"><Icon :name="item.icon" :size="22"/><span>{{item.short}}</span></button></nav>
    <div v-if="fullBookOpen" class="overlay" @click.self="!downloadingBook && (fullBookOpen=null)"><section class="dialog download-dialog" role="dialog" aria-modal="true" aria-labelledby="download-title"><button class="dialog-close round-button" :disabled="!!downloadingBook" aria-label="关闭词库下载" @click="fullBookOpen=null"><Icon name="close"/></button><p class="eyebrow">A BIGGER WORLD OF WORDS</p><h2 id="download-title">把更多单词，放进口袋。</h2><h3>{{fullBookOpen.title}}</h3><p>内置 {{fullBookOpen.selectedCount || 180}} 词精选<span v-if="fullCount(fullBookOpen)">；完整版实际收录 {{fullCount(fullBookOpen)}} 词</span>。完整词库覆盖 ECDICT 对应标签的全部有效词条，可下载后离线使用。它来自开源词典标签，收录范围与现行考试大纲可能不同。</p><p>下载不影响已有进度。词库保存在当前设备；备份恢复完整词书时需要网络或本机已有缓存。</p><button class="primary-button" :disabled="!!downloadingBook" @click="getFullBook(fullBookOpen)"><Icon name="download" :size="18"/>{{downloadingBook?'正在下载并保存…':'下载完整词库'}}</button><button class="text-button" :disabled="!!downloadingBook" @click="fullBookOpen=null">先用离线精选</button></section></div>
    <Transition name="toast"><div v-if="toast" class="toast-message" role="status"><Icon name="check" :size="18"/>{{toast}}</div></Transition>
    <div v-if="tutorialOpen" class="overlay" @click.self="closeTutorial"><section class="dialog tutorial-dialog" role="dialog" aria-modal="true" aria-labelledby="tutorial-title"><button class="dialog-close round-button" aria-label="跳过教程" @click="closeTutorial"><Icon name="close" :size="20"/></button><div class="tutorial-art"><div class="tutorial-orbit"></div><Icon :name="tutorials[tutorialStep].icon" :size="69"/></div><p class="eyebrow">HELLO, ONEWORD</p><h2 id="tutorial-title">{{tutorials[tutorialStep].title}}</h2><p>{{tutorials[tutorialStep].text}}</p><div class="tutorial-dots"><i v-for="i in 3" :class="{active:tutorialStep===i-1}"></i></div><button class="primary-button" @click="tutorialStep<2?tutorialStep++:closeTutorial()">{{tutorialStep<2?'下一步':'从一个词开始'}}<Icon name="arrow" :size="18"/></button><button class="text-button" @click="closeTutorial">{{tutorialStep<2?'跳过，直接体验':'我知道了'}}</button></section></div>
    <div v-if="settingOpen" class="overlay" @click.self="settingOpen=false"><section class="dialog settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title"><div class="dialog-title"><div><p class="eyebrow">YOUR OWN PACE</p><h2 id="settings-title">按自己的节奏</h2></div><button class="round-button" aria-label="关闭设置" @click="settingOpen=false"><Icon name="close"/></button></div><AccountPanel v-if="cloud" :client="cloud" :status="cloudStatus" /><fieldset class="learning-order-settings"><legend>学习顺序</legend><div class="learning-order-options"><label v-for="order in learningOrders" :key="order.id" class="learning-order-option" :class="{selected:selectedOrder.id===order.id}"><input type="radio" name="learning-order" :value="order.id" :checked="selectedOrder.id===order.id" @change="changeSetting('learningOrder',order.id)"/><span><b>{{order.label}}<small v-if="order.id==='adaptive'">推荐</small></b><span>{{order.description}}</span></span><Icon v-if="selectedOrder.id===order.id" name="check" :size="17"/></label></div><p class="learning-order-note">到期词始终先于新词；切换后从下一组开始生效。</p><p v-if="page==='study' && !sessionDone" class="learning-order-current">本组使用「{{sessionOrder.label}}」，继续学习时顺序保持不变。</p></fieldset><div class="setting-row"><div><b>每天新学</b><p>先复习，再学一点新的。</p></div><select aria-label="每日新词数量" :value="state.settings.dailyGoal" @change="changeSetting('dailyGoal',Number($event.target.value))"><option v-for="n in [...new Set([state.settings.dailyGoal,5,10,15,20,30,40,50])].sort((a,b)=>a-b)" :value="n">{{n}} 词</option></select></div><div class="setting-row"><div><b>先回忆，再看答案</b><p>开启后先隐藏中文，主动想起更牢固。</p></div><button role="switch" :aria-checked="state.settings.recallFirst" aria-label="先回忆再看答案" class="toggle" :class="{on:state.settings.recallFirst}" @click="changeSetting('recallFirst',!state.settings.recallFirst)"><i></i></button></div><div class="setting-row"><div><b>朗读口音</b><p>声音由当前设备的语音服务提供。</p></div><select aria-label="朗读口音" :value="state.settings.accent || 'us'" @change="changeSetting('accent',$event.target.value)"><option value="us">美音</option><option value="uk">英音</option></select></div><div class="settings-data"><h3>你的积累，自己保管</h3><p>游客进度保存在本机；登录后自动同步词集、复习计划、设置和每日记录。断网仍可学习，联网后合并。备份是额外保障，恢复会替换本机进度；登录时也会同步到当前账号。</p><div class="data-actions"><button class="secondary-button" @click="exportData"><Icon name="download" :size="18"/>导出备份</button><label class="secondary-button import-button" :aria-busy="importingBackup"><Icon name="upload" :size="18"/>{{importingBackup?'正在恢复…':'恢复备份'}}<input type="file" :disabled="importingBackup" accept="application/json,.json" @change="importData"/></label></div></div><button class="settings-help text-button" @click="settingOpen=false;tutorialOpen=true;tutorialStep=0"><Icon name="help" :size="18"/>再看一次使用指南</button><div class="settings-about"><Icon name="leaf" :size="20"/><span>一词 OneWord · 1.0<br><small>离线学习 · 账号同步 · 无广告</small></span></div></section></div>
    <div v-if="detail" class="overlay" @click.self="detail=null"><section class="dialog detail-dialog" role="dialog" aria-modal="true" aria-labelledby="detail-title"><button class="dialog-close round-button" aria-label="关闭单词详情" @click="detail=null"><Icon name="close"/></button><span class="tiny-label">A WORD YOU MET</span><h2 id="detail-title">{{detail.word}}</h2><p class="phonetic">{{detail.phonetic}}<button class="round-button" aria-label="朗读单词" @click="pronounce(detail)"><Icon name="sound" :size="18"/></button></p><div class="detail-core"><small>核心义 · {{detail.pos}}</small><h3>{{detail.coreMeaning}}</h3></div><div class="expanded-meaning"><div v-for="(meaning,index) in detail.meanings" :key="index"><small>{{meaning.pos}}</small><span>{{meaning.meaning}}</span></div><blockquote v-if="detail.example"><p>{{detail.example.en}}</p><span>{{detail.example.zh}}</span></blockquote></div><p class="detail-schedule">当前状态：{{collectionLabels[state.words[detail.id]?.status] || '尚未学习'}}<br>下次复习：{{state.words[detail.id]?.dueAt ? new Date(state.words[detail.id].dueAt).toLocaleString('zh-CN'):'学习后安排'}}</p><button class="secondary-button" @click="moveToLearning(detail)">移回不认识，重新学习<Icon name="arrow" :size="17"/></button></section></div>
  </div>
</template>
