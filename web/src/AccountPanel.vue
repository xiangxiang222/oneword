<script setup>
import { computed, ref } from 'vue'
import Icon from './Icon.vue'
const props = defineProps({ status: Object, client: Object, expanded: Boolean })
const open = ref(false)
const mode = ref('login')
const username = ref('')
const password = ref('')
const newPassword = ref('')
const importGuest = ref(true)
const error = ref('')
const busy = ref(false)
const managing = ref('')
const syncLabel = computed(() => ({ syncing: '同步中', pending: '待同步', idle: '已同步', offline: '离线保存', expired: '登录已过期', error: '同步待重试' }[props.status.phase] || '本机保存'))
async function action(fn) {
  if (busy.value) return
  busy.value = true; error.value = ''
  try { await fn(); password.value = ''; newPassword.value = '' }
  catch (reason) { error.value = reason.message || '操作未完成，请稍后重试' }
  finally { busy.value = false }
}
function authenticate() {
  return action(async () => {
    await props.client.authenticate(mode.value, { username: username.value, password: password.value }, importGuest.value)
    open.value = false
  })
}
function logout() {
  return action(async () => { await props.client.logout(); managing.value = '' })
}
function removeAccount() {
  if (!window.confirm('删除账号会永久删除云端词集、复习进度和学习记录，其他设备的登录也会失效。确认删除？')) return
  return action(async () => { await props.client.deleteAccount(password.value); managing.value = '' })
}
</script>

<template>
  <section class="account-panel" aria-label="账号与同步">
    <div class="account-heading"><span class="account-symbol"><Icon :name="status.user ? 'shield' : 'leaf'" :size="23" /></span><div><h3>{{ status.user ? status.user.username : '让每次积累，都跟着你' }}</h3><p>{{ status.user ? syncLabel : '登录后，换个手机也能接着学。' }}</p></div><button v-if="!status.user && !open" class="account-entry" @click="open=true">登录 / 注册<Icon name="arrow" :size="16" /></button></div>
    <template v-if="status.user">
      <p class="account-message" role="status">{{ status.message }}<span v-if="status.lastSyncedAt"><br>上次同步 {{ new Date(status.lastSyncedAt).toLocaleString('zh-CN') }}</span></p>
      <div class="account-actions"><button v-if="status.phase==='expired'" class="account-link" @click="open=true">重新登录</button><button v-else class="account-link" :disabled="busy || status.phase==='syncing'" @click="action(()=>client.sync())">立即同步</button><button class="account-link muted" :disabled="busy" @click="logout">退出登录</button><button class="account-link muted" @click="managing=managing ? '' : 'password';error=''">账号管理</button></div>
      <div v-if="managing" class="account-management"><div class="account-tabs"><button :class="{active:managing==='password'}" @click="managing='password';error=''">修改密码</button><button :class="{active:managing==='delete'}" @click="managing='delete';error=''">删除账号</button></div><form @submit.prevent="managing==='delete' ? removeAccount() : action(async()=>{await client.changePassword(password,newPassword);managing='';open=true})"><label>当前密码<input v-model="password" type="password" autocomplete="current-password" required minlength="8" maxlength="128" /></label><label v-if="managing==='password'">新密码<input v-model="newPassword" type="password" autocomplete="new-password" required minlength="8" maxlength="128" /></label><p v-else class="account-note">永久删除账号及云端学习记录，需要输入密码确认。游客记录会保留。</p><button class="secondary-button" :disabled="busy">{{busy ? '正在处理…' : managing==='delete' ? '永久删除账号与云端记录' : '保存新密码并重新登录'}}</button></form></div>
    </template>
    <div v-if="open" class="account-form-wrap"><div class="account-tabs"><button :class="{active:mode==='login'}" @click="mode='login';error=''">登录</button><button :class="{active:mode==='register'}" @click="mode='register';error=''">创建账号</button><button class="account-form-close" aria-label="收起登录表单" @click="open=false;password='';error=''">收起</button></div><form @submit.prevent="authenticate"><label>账号<input v-model="username" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required minlength="3" maxlength="32" pattern="[A-Za-z0-9_.\-]{3,32}" placeholder="3–32 位字母、数字或 _ . -" /></label><label>密码<input v-model="password" name="password" type="password" :autocomplete="mode==='register' ? 'new-password' : 'current-password'" required minlength="8" maxlength="128" placeholder="至少 8 位，请妥善保存" /></label><label v-if="!status.user" class="account-checkbox"><input v-model="importGuest" type="checkbox" /><span>合并这台设备上的游客学习进度</span></label><p class="account-note">{{mode==='register' ? '创建账号即同意将学习进度存到云端，用于跨设备同步。请牢记账号密码，目前不支持邮箱或短信找回。' : '同一个账号，继续你的词集、复习计划和学习记录。'}} 密码经 HTTPS 传输，云端不保存密码原文。备份不含登录信息。</p><button class="primary-button" :disabled="busy">{{busy ? '正在连接…' : mode==='register' ? '创建账号，保存积累' : '登录并同步' }}<Icon name="arrow" :size="18" /></button></form></div>
    <p v-if="error" class="account-error" role="alert">{{error}}</p>
  </section>
</template>
