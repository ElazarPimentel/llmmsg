"""
GTK4 + libadwaita window on top of HubClient + SSEStream.

Single-file v0.1. Layout: AdwNavigationSplitView with a rooms sidebar (joined
AROs + active DM senders) and a content pane (room title, message listview,
compose entry). Receive path: SSE worker -> GLib.idle_add -> room ListStore.
Send path: threaded HubClient.send() -> optimistic local add.

Run:
    python3 -m llmmsg_chat.gui --agent elazar-whey-gui-w --cwd "$(pwd)"
"""

VERSION = '0.2.0'

import argparse
import os
import signal
import sys
import threading
from typing import Optional

import gi
gi.require_version('Gtk', '4.0')
gi.require_version('Adw', '1')
from gi.repository import Adw, Gio, GLib, GObject, Gtk  # noqa: E402

from .hub_client import HubClient, HubError, SSEStream


# ---------------------------------------------------------------------------
# Message GObject — wraps the dict shape the hub returns so Gio.ListStore
# can hold them for Gtk.ListView consumption.
# ---------------------------------------------------------------------------


class Message(GObject.Object):
    __gtype_name__ = 'LlmmsgMessage'

    msg_id = GObject.Property(type=int, default=0)
    sender = GObject.Property(type=str, default='')
    body = GObject.Property(type=str, default='')
    origin_aro = GObject.Property(type=str, default='')
    tag = GObject.Property(type=str, default='')

    @classmethod
    def from_event(cls, event: dict) -> 'Message':
        body = event.get('body')
        if isinstance(body, dict):
            text = body.get('message') or ''
        elif body is None:
            text = ''
        else:
            text = str(body)
        sender = event.get('from') or event.get('sender') or '?'
        return cls(
            msg_id=event.get('id') or 0,
            sender=sender,
            body=text,
            origin_aro=event.get('origin_aro') or '',
            tag=event.get('tag') or '',
        )


# ---------------------------------------------------------------------------
# ChatWindow
# ---------------------------------------------------------------------------


class ChatWindow(Adw.ApplicationWindow):
    def __init__(self, app: 'ChatApp', client: HubClient, agent: str, cwd: str):
        super().__init__(application=app)
        self.set_default_size(960, 640)
        self.set_title(f'llmmsg-chat · {agent}')

        self.client = client
        self.agent = agent
        self.cwd = cwd
        self.rooms: dict[str, Gio.ListStore] = {}   # bucket -> ListStore of Message
        self.unread: dict[str, int] = {}            # bucket -> count
        self.row_by_bucket: dict[str, Gtk.ListBoxRow] = {}
        self.label_by_bucket: dict[str, Gtk.Label] = {}
        self.scroll_by_bucket: dict[str, Gtk.ScrolledWindow] = {}
        self.current_bucket: Optional[str] = None

        self._build_ui()

        # SSE worker — callbacks fire on worker thread, re-dispatched via idle_add
        self.sse = SSEStream(
            client.host, client.port, agent, cwd,
            on_event=self._sse_event_from_worker,
            on_status=self._sse_status_from_worker,
        )
        self.sse.start()

        # Async bootstrap: load joined AROs and their history
        GLib.idle_add(self._bootstrap)

    # ------------- UI construction -------------

    def _build_ui(self):
        split = Adw.NavigationSplitView()
        self.set_content(split)

        # --- sidebar ---
        sidebar_page = Adw.NavigationPage.new(self._build_sidebar(), 'rooms')
        split.set_sidebar(sidebar_page)

        # --- content ---
        content_page = Adw.NavigationPage.new(self._build_content(), 'chat')
        split.set_content(content_page)

    def _build_sidebar(self) -> Gtk.Widget:
        toolbar = Adw.ToolbarView()

        header = Adw.HeaderBar()
        join_btn = Gtk.MenuButton(icon_name='list-add-symbolic',
                                  tooltip_text='Join an ARO')
        join_btn.set_popover(self._build_join_popover())
        header.pack_end(join_btn)
        toolbar.add_top_bar(header)

        self.rooms_list = Gtk.ListBox()
        self.rooms_list.add_css_class('navigation-sidebar')
        self.rooms_list.set_selection_mode(Gtk.SelectionMode.SINGLE)
        self.rooms_list.connect('row-activated', self._on_room_activated)

        scroll = Gtk.ScrolledWindow(vexpand=True, hexpand=True)
        scroll.set_child(self.rooms_list)
        toolbar.set_content(scroll)
        return toolbar

    def _build_join_popover(self) -> Gtk.Popover:
        pop = Gtk.Popover()
        pop.set_size_request(320, -1)
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8,
                      margin_start=12, margin_end=12, margin_top=12, margin_bottom=12)
        box.append(Gtk.Label(label='Join ARO', xalign=0))

        entry = Gtk.Entry(placeholder_text='type a name or pick below')
        entry.connect('activate', lambda e: self._do_join(e.get_text(), pop))
        box.append(entry)
        self._join_entry = entry

        btn_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6,
                          halign=Gtk.Align.END)
        join_btn = Gtk.Button(label='Join')
        join_btn.add_css_class('suggested-action')
        join_btn.connect('clicked', lambda _b: self._do_join(entry.get_text(), pop))
        btn_row.append(join_btn)
        box.append(btn_row)

        # Divider + existing-ARO picker. Populated async when the popover opens.
        box.append(Gtk.Separator(orientation=Gtk.Orientation.HORIZONTAL))
        header_row = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=4)
        header_row.append(Gtk.Label(label='Existing AROs', xalign=0, hexpand=True))
        self._aro_status = Gtk.Label(xalign=1)
        self._aro_status.add_css_class('caption')
        self._aro_status.add_css_class('dim-label')
        header_row.append(self._aro_status)
        box.append(header_row)

        self._aro_listbox = Gtk.ListBox()
        self._aro_listbox.add_css_class('boxed-list')
        self._aro_listbox.set_selection_mode(Gtk.SelectionMode.NONE)
        self._aro_listbox.connect('row-activated', self._on_aro_pick, pop)

        scroll = Gtk.ScrolledWindow()
        scroll.set_propagate_natural_height(True)
        scroll.set_max_content_height(260)
        scroll.set_min_content_height(120)
        scroll.set_child(self._aro_listbox)
        box.append(scroll)

        pop.set_child(box)
        # Refresh the list each time the popover opens (cheap call, ~few ms).
        pop.connect('show', self._refresh_aro_list)
        return pop

    def _refresh_aro_list(self, _popover):
        if self._aro_status:
            self._aro_status.set_label('loading…')

        def work():
            try:
                data = self.client.aro_list()
                GLib.idle_add(self._populate_aro_list, data)
            except Exception as exc:
                GLib.idle_add(self._aro_list_failed, str(exc))

        threading.Thread(target=work, daemon=True, name='aro-list').start()

    def _populate_aro_list(self, data: dict):
        # Strip existing rows
        child = self._aro_listbox.get_first_child()
        while child is not None:
            nxt = child.get_next_sibling()
            self._aro_listbox.remove(child)
            child = nxt

        names = sorted(data.keys(), key=str.lower)
        self._aro_status.set_label(f'{len(names)} total')
        for name in names:
            members = data.get(name) or []
            bucket = f'aro:{name}'
            joined = bucket in self.rooms

            row = Gtk.ListBoxRow()
            row_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=8,
                              margin_start=12, margin_end=12,
                              margin_top=6, margin_bottom=6)
            name_lbl = Gtk.Label(label=name, xalign=0, hexpand=True)
            row_box.append(name_lbl)

            members_lbl = Gtk.Label(label=f'{len(members)} member{"s" if len(members) != 1 else ""}',
                                     xalign=1)
            members_lbl.add_css_class('caption')
            members_lbl.add_css_class('dim-label')
            row_box.append(members_lbl)

            if joined:
                tick = Gtk.Image.new_from_icon_name('emblem-ok-symbolic')
                tick.set_tooltip_text('already joined')
                row_box.append(tick)
            row.set_child(row_box)
            row.aro_name = name  # type: ignore[attr-defined]
            self._aro_listbox.append(row)

        if not names:
            placeholder = Gtk.Label(label='(no AROs exist yet)', margin_top=12, margin_bottom=12)
            placeholder.add_css_class('dim-label')
            self._aro_listbox.set_placeholder(placeholder)
        return False

    def _aro_list_failed(self, err: str):
        self._aro_status.set_label('load failed')
        self._toast(f'aro list: {err}')
        return False

    def _on_aro_pick(self, _listbox, row: Gtk.ListBoxRow, popover: Gtk.Popover):
        name = getattr(row, 'aro_name', None)
        if not name:
            return
        bucket = f'aro:{name}'
        if bucket in self.rooms:
            # Already joined — just focus it and close the popover.
            popover.popdown()
            self._select_room(bucket)
            return
        self._do_join(name, popover)

    def _build_content(self) -> Gtk.Widget:
        toolbar = Adw.ToolbarView()

        self.content_header = Adw.HeaderBar()
        self.room_title = Adw.WindowTitle.new('', '')
        self.content_header.set_title_widget(self.room_title)

        leave_btn = Gtk.Button(icon_name='user-trash-symbolic',
                               tooltip_text='Leave current ARO')
        leave_btn.connect('clicked', self._on_leave_clicked)
        self.content_header.pack_end(leave_btn)

        toolbar.add_top_bar(self.content_header)

        # Stack holds one chat page per room + an empty page
        self.chat_stack = Gtk.Stack()
        self.chat_stack.set_transition_type(Gtk.StackTransitionType.CROSSFADE)
        self.chat_stack.set_vexpand(True)
        self.chat_stack.set_hexpand(True)

        self._empty = Adw.StatusPage(
            icon_name='mail-message-new-symbolic',
            title='No room selected',
            description='Pick a room from the sidebar, or press + to join an ARO.',
        )
        self.chat_stack.add_named(self._empty, '__empty__')
        self.chat_stack.set_visible_child_name('__empty__')

        # Compose row (shared across rooms)
        compose = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6,
                          margin_start=12, margin_end=12,
                          margin_top=6, margin_bottom=12)
        self.compose_entry = Gtk.Entry(placeholder_text='Message (Enter to send)',
                                       hexpand=True)
        self.compose_entry.connect('activate', self._on_send)
        send_btn = Gtk.Button(icon_name='document-send-symbolic', tooltip_text='Send')
        send_btn.add_css_class('suggested-action')
        send_btn.connect('clicked', self._on_send)
        compose.append(self.compose_entry)
        compose.append(send_btn)

        content_box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
        content_box.append(self.chat_stack)
        content_box.append(compose)
        toolbar.set_content(content_box)
        return toolbar

    # ------------- Bootstrap: discover joined AROs, preload history -------------

    def _bootstrap(self):
        def work():
            try:
                info = self.client.online(self.agent)
                aros = info.get('aros') or []
                GLib.idle_add(self._on_aros_loaded, aros)
            except Exception as exc:
                GLib.idle_add(self._toast, f'bootstrap failed: {exc}')
        threading.Thread(target=work, daemon=True, name='bootstrap').start()
        return False

    def _on_aros_loaded(self, aros):
        for aro in aros:
            self._add_room(f'aro:{aro}')
        if aros:
            self._select_room(f'aro:{aros[0]}')
        return False

    # ------------- Rooms: add, select, load history -------------

    def _add_room(self, bucket: str):
        if bucket in self.rooms:
            return
        store = Gio.ListStore(item_type=Message)
        self.rooms[bucket] = store
        self.unread[bucket] = 0

        # Sidebar row
        row = Gtk.ListBoxRow()
        row_box = Gtk.Box(orientation=Gtk.Orientation.HORIZONTAL, spacing=6,
                          margin_start=12, margin_end=12, margin_top=6, margin_bottom=6)
        name_label = Gtk.Label(label=bucket, xalign=0, hexpand=True)
        badge = Gtk.Label(label='')
        badge.add_css_class('caption')
        badge.add_css_class('dim-label')
        row_box.append(name_label)
        row_box.append(badge)
        row.set_child(row_box)
        row.bucket_name = bucket  # type: ignore[attr-defined]
        self.rooms_list.append(row)
        self.row_by_bucket[bucket] = row
        self.label_by_bucket[bucket] = badge

        # Chat page
        factory = Gtk.SignalListItemFactory()
        factory.connect('setup', self._message_setup)
        factory.connect('bind', self._message_bind)
        listview = Gtk.ListView(model=Gtk.NoSelection(model=store), factory=factory)
        listview.add_css_class('llmmsg-chat-list')
        scroll = Gtk.ScrolledWindow(vexpand=True, hexpand=True)
        scroll.set_child(listview)
        scroll.set_policy(Gtk.PolicyType.NEVER, Gtk.PolicyType.AUTOMATIC)
        self.chat_stack.add_named(scroll, bucket)
        self.scroll_by_bucket[bucket] = scroll

        # Preload history (async)
        self._load_history(bucket)

    def _load_history(self, bucket: str):
        def work():
            try:
                rows = self.client.history(self.agent, bucket, limit=80)
                GLib.idle_add(self._on_history, bucket, rows)
            except Exception as exc:
                GLib.idle_add(self._toast, f'history {bucket}: {exc}')
        threading.Thread(target=work, daemon=True, name=f'hist-{bucket}').start()

    def _on_history(self, bucket: str, rows: list):
        store = self.rooms.get(bucket)
        if store is None:
            return False
        store.remove_all()
        for r in rows:
            store.append(Message.from_event(r))
        # Auto-scroll after the layout runs
        GLib.idle_add(self._scroll_to_bottom, bucket)
        return False

    def _select_room(self, bucket: str):
        if bucket not in self.rooms:
            return
        self.current_bucket = bucket
        self.room_title.set_title(bucket)
        self.room_title.set_subtitle(f'as {self.agent}')
        self.chat_stack.set_visible_child_name(bucket)
        self.unread[bucket] = 0
        self._refresh_badge(bucket)
        row = self.row_by_bucket.get(bucket)
        if row is not None:
            self.rooms_list.select_row(row)
        GLib.idle_add(self._scroll_to_bottom, bucket)

    def _scroll_to_bottom(self, bucket: str):
        scroll = self.scroll_by_bucket.get(bucket)
        if scroll is None:
            return False
        adj = scroll.get_vadjustment()
        if adj is not None:
            adj.set_value(max(0.0, adj.get_upper() - adj.get_page_size()))
        return False

    def _refresh_badge(self, bucket: str):
        label = self.label_by_bucket.get(bucket)
        if label is None:
            return
        count = self.unread.get(bucket, 0)
        label.set_label(f'{count}' if count > 0 else '')

    # ------------- Message listview item factory -------------

    def _message_setup(self, _factory, list_item):
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=2,
                      margin_start=12, margin_end=12, margin_top=4, margin_bottom=4)
        sender_label = Gtk.Label(xalign=0)
        sender_label.add_css_class('caption')
        sender_label.add_css_class('dim-label')
        body_label = Gtk.Label(xalign=0, wrap=True, selectable=True, use_markup=False)
        body_label.set_halign(Gtk.Align.START)
        box.append(sender_label)
        box.append(body_label)
        list_item.set_child(box)
        # Attach refs for bind step
        list_item.sender_label = sender_label    # type: ignore[attr-defined]
        list_item.body_label = body_label        # type: ignore[attr-defined]

    def _message_bind(self, _factory, list_item):
        msg: Message = list_item.get_item()
        list_item.sender_label.set_label(f'{msg.sender}')
        list_item.body_label.set_label(msg.body)

    # ------------- Send -------------

    def _on_send(self, _widget):
        bucket = self.current_bucket
        if not bucket:
            self._toast('select a room first')
            return
        text = self.compose_entry.get_text().strip()
        if not text:
            return
        self.compose_entry.set_text('')
        # bucket already has the correct prefix ('aro:X' or plain agent for DM)
        target = bucket
        def work():
            try:
                result = self.client.send(self.agent, target, {'message': text})
                # Optimistic local add so user sees their line immediately.
                # The SSE round-trip (for AROs) will not re-deliver to sender.
                msg = Message(
                    msg_id=(result.get('ids') or [0])[0]
                            if isinstance(result.get('ids'), list) else 0,
                    sender=self.agent, body=text,
                    origin_aro=bucket if bucket.startswith('aro:') else '',
                    tag=result.get('tag') or '',
                )
                GLib.idle_add(self._append_local, bucket, msg)
            except Exception as exc:
                GLib.idle_add(self._toast, f'send failed: {exc}')
        threading.Thread(target=work, daemon=True, name='send').start()

    def _append_local(self, bucket: str, msg: Message):
        store = self.rooms.get(bucket)
        if store is None:
            return False
        store.append(msg)
        GLib.idle_add(self._scroll_to_bottom, bucket)
        return False

    # ------------- Join / Leave ARO -------------

    def _do_join(self, raw_name: str, popover: Gtk.Popover):
        name = (raw_name or '').strip().removeprefix('aro:').strip()
        if not name:
            return
        popover.popdown()
        bucket = f'aro:{name}'
        def work():
            try:
                self.client.aro_join(self.agent, name)
                GLib.idle_add(self._after_join, bucket)
            except Exception as exc:
                GLib.idle_add(self._toast, f'join failed: {exc}')
        threading.Thread(target=work, daemon=True, name='aro-join').start()

    def _after_join(self, bucket: str):
        self._add_room(bucket)
        self._select_room(bucket)
        return False

    def _on_leave_clicked(self, _btn):
        bucket = self.current_bucket
        if not bucket or not bucket.startswith('aro:'):
            self._toast('no ARO selected')
            return
        name = bucket.removeprefix('aro:')
        def work():
            try:
                self.client.aro_leave(self.agent, name)
                GLib.idle_add(self._after_leave, bucket)
            except Exception as exc:
                GLib.idle_add(self._toast, f'leave failed: {exc}')
        threading.Thread(target=work, daemon=True, name='aro-leave').start()

    def _after_leave(self, bucket: str):
        row = self.row_by_bucket.pop(bucket, None)
        if row is not None:
            self.rooms_list.remove(row)
        self.label_by_bucket.pop(bucket, None)
        scroll = self.scroll_by_bucket.pop(bucket, None)
        if scroll is not None:
            self.chat_stack.remove(scroll)
        self.rooms.pop(bucket, None)
        self.unread.pop(bucket, None)
        if self.current_bucket == bucket:
            self.current_bucket = None
            self.chat_stack.set_visible_child_name('__empty__')
            self.room_title.set_title('')
            self.room_title.set_subtitle('')
        return False

    # ------------- SSE event dispatch -------------

    def _sse_event_from_worker(self, event: dict):
        GLib.idle_add(self._on_event, event)

    def _sse_status_from_worker(self, line: str):
        # Status is debug-only; swallow. Could surface via a statusbar later.
        pass

    def _on_event(self, event: dict):
        origin_aro = event.get('origin_aro')
        to = event.get('to')
        sender = event.get('from')

        # Bucket resolution: origin_aro (ARO fanout) or sender (incoming DM).
        # Outbound echo (sender == self.agent) is already added optimistically,
        # so skip; the hub does not round-trip AROs to the sender anyway.
        if sender == self.agent:
            return False
        if origin_aro:
            bucket = origin_aro
        elif to == self.agent:
            bucket = sender or ''
        else:
            return False
        if not bucket:
            return False

        if bucket not in self.rooms:
            self._add_room(bucket)

        store = self.rooms[bucket]
        # Dedupe by id — hub can redeliver on reconnect
        mid = event.get('id') or 0
        if mid:
            for i in range(store.get_n_items()):
                item = store.get_item(i)
                if item and item.msg_id == mid:
                    return False
        store.append(Message.from_event(event))

        if bucket == self.current_bucket:
            GLib.idle_add(self._scroll_to_bottom, bucket)
        else:
            self.unread[bucket] = self.unread.get(bucket, 0) + 1
            self._refresh_badge(bucket)
        return False

    # ------------- Room activation -------------

    def _on_room_activated(self, _listbox, row: Gtk.ListBoxRow):
        bucket = getattr(row, 'bucket_name', None)
        if bucket:
            self._select_room(bucket)

    # ------------- Toast + cleanup -------------

    def _toast(self, text: str):
        # Lightweight: write to stderr. Could upgrade to Adw.ToastOverlay later.
        sys.stderr.write(f'[toast] {text}\n')
        sys.stderr.flush()
        return False

    def cleanup(self):
        try:
            self.sse.stop()
        except Exception:
            pass
        try:
            self.client.unregister(self.agent)
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Application
# ---------------------------------------------------------------------------


class ChatApp(Adw.Application):
    def __init__(self, ns: argparse.Namespace):
        # NON_UNIQUE lets multiple instances coexist (one per --agent), and
        # avoids stale-dbus single-instance behavior where a silent second
        # launch would hand control to a first process and immediately exit.
        super().__init__(application_id='io.llmmsg.Chat',
                         flags=Gio.ApplicationFlags.NON_UNIQUE)
        self.ns = ns
        self.win: Optional[ChatWindow] = None

    def do_activate(self):
        if self.win is None:
            client = HubClient(host=self.ns.host, port=self.ns.port)
            try:
                client.register(self.ns.agent, self.ns.cwd, old_agent=self.ns.agent)
            except HubError as exc:
                sys.stderr.write(f'register failed: {exc}\n')
                self.quit()
                return
            self.win = ChatWindow(self, client, self.ns.agent, self.ns.cwd)
            self.win.connect('close-request', self._on_close)
        self.win.present()

    def _on_close(self, win: ChatWindow):
        win.cleanup()
        self.quit()
        return False


# ---------------------------------------------------------------------------
# Entry
# ---------------------------------------------------------------------------


def main() -> int:
    parser = argparse.ArgumentParser(
        prog='llmmsg-chat',
        description=f'GTK4 + libadwaita client for llmmsg-channel (v{VERSION})',
    )
    parser.add_argument('--agent', default=os.environ.get('LLMMSG_AGENT', ''))
    parser.add_argument('--cwd', default=os.environ.get('LLMMSG_CWD', os.getcwd()))
    parser.add_argument('--host', default=os.environ.get('LLMMSG_HUB_HOST', '127.0.0.1'))
    parser.add_argument('--port', type=int,
                        default=int(os.environ.get('LLMMSG_HUB_PORT', '9701')))
    ns = parser.parse_args()

    if not ns.agent:
        sys.stderr.write('error: --agent or LLMMSG_AGENT required\n')
        return 2

    print(f'llmmsg-chat v{VERSION} — agent={ns.agent} hub={ns.host}:{ns.port}')

    app = ChatApp(ns)

    # Terminal signals (Ctrl-C, SIGTERM from timeout/systemctl) must close the
    # window cleanly so the agent unregisters and the SSE stream shuts down.
    def _graceful(_signo, _frame):
        if app.win is not None:
            app.win.cleanup()
        app.quit()
    signal.signal(signal.SIGINT, _graceful)
    signal.signal(signal.SIGTERM, _graceful)

    return app.run(None)


if __name__ == '__main__':
    sys.exit(main())
