import { configure } from 'mobx';

import NetworkMonitor from 'Services/network-monitor';

import RootStore from 'Stores';

configure({ enforceActions: 'observed' });

const setStorageEvents = root_store => {
    window.addEventListener('storage', evt => {
        switch (evt.key) {
            case 'client.accounts': {
                const active_loginid = root_store.client.loginid;
                const new_currency = JSON.parse(evt.newValue)?.[active_loginid]?.currency;
                const old_currency = JSON.parse(evt.oldValue)?.[active_loginid]?.currency;

                if (document.hidden && new_currency && old_currency !== new_currency) {
                    root_store.client.updateAccountCurrency(new_currency, false);
                }
                break;
            }
            case 'active_loginid':
                if (localStorage.getItem('active_loginid') === 'null' || !localStorage.getItem('active_loginid')) {
                    root_store.client.logout();
                }
                if (document.hidden) {
                    window.location.reload();
                }
                break;
            // Cross-tab logout sentinel: logout.js writes this key on logout
            case 'logout_event':
                if (evt.newValue) {
                    root_store.client.logout();
                }
                break;
            // no default
        }
    });
};

const initStore = async notification_messages => {
    const url_query_string = window.location.search;
    const url_params = new URLSearchParams(url_query_string);

    if (url_params.get('action') === 'signup') {
        // If a user comes from the signup process, give them a clean setup
        const server_url = localStorage.getItem('config.server_url');
        localStorage.clear();
        if (server_url) localStorage.setItem('config.server_url', server_url);
    }

    const root_store = new RootStore();

    // Set up global store reference for debugging
    if (typeof window !== 'undefined') {
        window.__deriv_store = root_store;
    }

    setStorageEvents(root_store);

    NetworkMonitor.init(root_store);
    root_store.client.init();
    root_store.common.init();
    root_store.ui.init(notification_messages);

    return root_store;
};

export default initStore;
