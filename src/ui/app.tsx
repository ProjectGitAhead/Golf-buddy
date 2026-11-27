import { useEffect, useState } from 'preact/hooks';
import { startStoreSync, useStore } from '../store/use-store';
import { Icon, SyncBadge } from './components/common';
import { Courses } from './screens/courses';
import { Handicap } from './screens/handicap';
import { Play } from './screens/play';
import { Shots } from './screens/shots';

export type Tab = 'play' | 'handicap' | 'shots' | 'courses';

const TABS: { id: Tab; label: string; icon: 'flag' | 'trend' | 'target' | 'map' }[] = [
  { id: 'play', label: 'Play', icon: 'flag' },
  { id: 'handicap', label: 'Handicap', icon: 'trend' },
  { id: 'shots', label: 'Shots', icon: 'target' },
  { id: 'courses', label: 'Courses', icon: 'map' },
];

export function App() {
  const store = useStore();
  const [tab, setTab] = useState<Tab>('play');
  const [startCourseId, setStartCourseId] = useState<string | null>(null);

  useEffect(() => { startStoreSync(); }, []);

  const go = (t: Tab) => {
    setTab(t);
    document.getElementById('main')?.scrollTo({ top: 0 });
  };
  const playCourse = (courseId: string) => { setStartCourseId(courseId); go('play'); };

  return (
    <div class="app">
      <header class="app-head">
        <div class="brand"><Icon name="flag" size={20} />Golf Buddy</div>
        <SyncBadge state={store.sync} localOk={store.localOk} />
      </header>
      <main class="main" id="main">
        {tab === 'play' && <Play startCourseId={startCourseId} onStarted={() => setStartCourseId(null)} />}
        {tab === 'handicap' && <Handicap onEditRound={() => go('play')} />}
        {tab === 'shots' && <Shots />}
        {tab === 'courses' && <Courses onPlay={playCourse} />}
      </main>
      <nav class="tabbar" aria-label="Sections">
        {TABS.map((t) => (
          <button class="tab" id={`tab-${t.id}`} aria-current={tab === t.id ? 'page' : undefined} onClick={() => go(t.id)}>
            <Icon name={t.icon} />{t.label}
          </button>
        ))}
      </nav>
    </div>
  );
}
