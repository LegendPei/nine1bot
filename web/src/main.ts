import { createApp } from 'vue'
import './style.css'
import App from './App.vue'
import { installAccessFetchInterceptor } from './api/access-auth'

installAccessFetchInterceptor()
createApp(App).mount('#app')
