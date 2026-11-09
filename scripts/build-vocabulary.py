#!/usr/bin/env python3
"""Build small, attributable study selections from a verified ECDICT CSV.

Usage: python3 scripts/build-vocabulary.py /path/to/ecdict.csv
Download the exact blob from the upstream API (raw.githubusercontent may be
unavailable on some networks). No private credentials are needed:
curl --http1.1 --fail --compressed -L \
  -H 'Accept: application/vnd.github.raw+json' \
  https://api.github.com/repos/skywind3000/ECDICT/git/blobs/0e527e22e0e0d22f012b0ed251a8dddd5891773b \
  -o /tmp/ecdict.csv
"""
import csv
import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BLOB = '0e527e22e0e0d22f012b0ed251a8dddd5891773b'
SOURCE_URL = 'https://github.com/skywind3000/ECDICT'
PRIMARY = '''apple orange banana pear grape peach lemon watermelon strawberry fruit vegetable carrot potato tomato onion bread rice milk egg meat fish chicken water tea coffee juice breakfast lunch dinner food book pen pencil ruler eraser desk chair table school classroom teacher student friend family father mother brother sister baby boy girl man woman child people house home room door window garden park street city country world sun moon star sky cloud rain snow wind tree flower grass river sea mountain day night morning afternoon evening today tomorrow yesterday time year month week hour minute color red blue green yellow black white pink brown purple happy sad good bad big small long short tall young old new easy hard hot cold warm cool clean beautiful kind help play read write listen speak sing dance run walk jump swim eat drink sleep learn love like have make take give come go see look open close start finish one two three four five six seven eight nine ten first second third dog cat bird horse cow sheep duck rabbit animal face hand head eye ear nose mouth hair foot leg arm body clothes shirt coat dress shoe hat bag ball game music picture story name number money birthday summer winter spring autumn left right up down near far inside outside always often sometimes never because before after again together'''.split()

# Original editorial examples and core meanings. They deliberately contain one
# teachable sense. Upstream alternative senses remain in `meanings`.
CURATED = {
 'focus': ('v.', '专注', 'Focus on one thing at a time.', '一次专注于一件事。'),
 'embrace': ('v.', '拥抱', 'Embrace a fresh start.', '拥抱一个新的开始。'),
 'approach': ('n.', '方法', 'Try a different approach.', '试试另一种方法。'),
 'achieve': ('v.', '实现', 'Small steps help you achieve your goal.', '小小的进步帮助你实现目标。'),
 'purpose': ('n.', '目的', 'Every small step has a purpose.', '每一小步都有它的目的。'),
 'balance': ('n.', '平衡', 'Find a balance between work and rest.', '在工作与休息之间找到平衡。'),
 'curious': ('adj.', '好奇的', 'Stay curious about the world.', '保持对世界的好奇。'),
 'create': ('v.', '创造', 'Create something you love.', '创造你喜欢的东西。'),
 'effort': ('n.', '努力', 'Every effort makes a difference.', '每一份努力都会带来改变。'),
 'habit': ('n.', '习惯', 'Reading is a daily habit.', '阅读是一种日常习惯。'),
 'improve': ('v.', '改善', 'A little practice can improve your skills.', '一点练习就能提升你的技能。'),
 'inspire': ('v.', '激励', 'Your story can inspire others.', '你的故事可以激励他人。'),
 'journey': ('n.', '旅程', 'Enjoy every part of the journey.', '享受旅程的每一部分。'),
 'opportunity': ('n.', '机会', 'Every day is a new opportunity.', '每一天都是一个新的机会。'),
 'patient': ('adj.', '耐心的', 'Be patient with yourself.', '对自己耐心一点。'),
 'progress': ('n.', '进步', 'Small progress is still progress.', '微小的进步也是进步。'),
 'reflect': ('v.', '反思', 'Take a moment to reflect.', '花一点时间反思。'),
 'resilient': ('adj.', '有韧性的', 'She remained resilient after the setback.', '遭遇挫折后，她依然坚韧。'),
 'serendipity': ('n.', '意外的美好发现', 'Finding this little bookshop was pure serendipity.', '发现这家小书店纯属美好的偶然。'),
 'ambition': ('n.', '志向', 'Her ambition is to become a teacher.', '她的志向是成为一名教师。'),
 'adapt': ('v.', '适应', 'We learn to adapt to change.', '我们学习适应变化。'),
 'discover': ('v.', '发现', 'Discover something new today.', '今天发现一点新东西。'),
 'essential': ('adj.', '必要的', 'Sleep is essential for learning.', '睡眠对学习至关重要。'),
 'persist': ('v.', '坚持', 'Persist even when progress is slow.', '即使进展缓慢，也要坚持。'),
 'recognize': ('v.', '认出', 'I recognize that familiar voice.', '我认出了那个熟悉的声音。'),
 'sustain': ('v.', '维持', 'Small habits sustain lasting change.', '小习惯维持长久的改变。'),
 'clarity': ('n.', '清晰', 'A quiet moment brings clarity.', '片刻宁静带来清晰的思路。'),
 'potential': ('n.', '潜力', 'Everyone has the potential to grow.', '每个人都有成长的潜力。'),
 'thrive': ('v.', '茁壮成长', 'Plants thrive with enough sunlight.', '阳光充足时，植物茁壮成长。'),
 'tranquil': ('adj.', '宁静的', 'The lake was tranquil at dawn.', '黎明时分，湖面十分宁静。'),
 'abundant': ('adj.', '充足的', 'The garden gets abundant sunlight.', '这座花园日照充足。'),
 'contemplate': ('v.', '深思', 'Take time to contemplate your next step.', '花些时间深思下一步。'),
 'apple': ('n.', '苹果', 'An apple a day is a simple treat.', '每天一个苹果，是简单的小享受。'),
 'friend': ('n.', '朋友', 'A good friend listens.', '好朋友懂得倾听。'),
 'learn': ('v.', '学习', 'We learn something new every day.', '我们每天都学到新的东西。'),
 'beautiful': ('adj.', '美丽的', 'It is a beautiful day.', '这是美好的一天。'),
 'together': ('adv.', '一起', 'We can learn together.', '我们可以一起学习。'),
}

# Common polysemes need an editorial choice: the upstream dictionary often
# lists a rare noun before the ordinary verb (give/弹性, can/装罐, still/蒸馏室).
# These original choices improve the study card without claiming corpus-based
# sense frequencies. Examples remain optional rather than fabricated.
CORE_OVERRIDES = {
 'a': ('art.', '一（个）'), 'about': ('prep.', '关于'),
 'academic': ('adj.', '学术的'), 'access': ('n.', '获取途径'),
 'address': ('n.', '地址'), 'appeal': ('n.', '吸引力'),
 'appreciate': ('v.', '欣赏'), 'as': ('conj.', '当…时'),
 'aspect': ('n.', '方面'), 'associate': ('v.', '联系'),
 'attorney': ('n.', '律师'), 'available': ('adj.', '可获得的'),
 'back': ('adv.', '向后'), 'band': ('n.', '乐队'), 'bar': ('n.', '酒吧'),
 'base': ('n.', '基础'), 'beat': ('v.', '击败'), 'benefit': ('n.', '益处'),
 'break': ('v.', '打破'), 'but': ('conj.', '但是'), 'by': ('prep.', '通过'),
 'campaign': ('n.', '活动'), 'can': ('aux.', '能够'), 'care': ('v.', '在意'),
 'carry': ('v.', '携带'), 'cell': ('n.', '细胞'), 'character': ('n.', '性格'),
 'chicken': ('n.', '鸡肉'), 'claim': ('v.', '声称'), 'close': ('v.', '关闭'),
 'cold': ('adj.', '寒冷的'), 'commit': ('v.', '承诺'), 'common': ('adj.', '常见的'),
 'conduct': ('v.', '进行'), 'conflict': ('n.', '冲突'),
 'corporate': ('adj.', '公司的'), 'couple': ('n.', '一对'),
 'critical': ('adj.', '关键的'), 'cross': ('v.', '穿过'),
 'current': ('adj.', '当前的'), 'cut': ('v.', '切'),
 'data': ('n.', '数据'), 'defense': ('n.', '防御'),
 'demonstrate': ('v.', '展示'), 'draw': ('v.', '画'), 'drink': ('v.', '喝'),
 'effect': ('n.', '影响'), 'energy': ('n.', '能量'), 'ensure': ('v.', '确保'),
 'eraser': ('n.', '橡皮'), 'ethnic': ('adj.', '民族的'), 'even': ('adv.', '甚至'),
 'evidence': ('n.', '证据'), 'executive': ('n.', '高管'),
 'expand': ('v.', '扩大'), 'extend': ('v.', '延伸'), 'feature': ('n.', '特点'),
 'final': ('adj.', '最终的'), 'fine': ('adj.', '好的'),
 'general': ('adj.', '一般的'), 'give': ('v.', '给'), 'good': ('adj.', '好的'),
 'great': ('adj.', '很棒的'), 'handle': ('v.', '处理'), 'hard': ('adj.', '困难的'),
 'hide': ('v.', '隐藏'), 'high': ('adj.', '高的'), 'hold': ('v.', '握住'),
 'image': ('n.', '图像'), 'impact': ('n.', '影响'), 'in': ('prep.', '在…里面'),
 'individual': ('n.', '个人'), 'industry': ('n.', '工业'),
 'information': ('n.', '信息'), 'initial': ('adj.', '最初的'),
 'issue': ('n.', '问题'), 'just': ('adv.', '仅仅'), 'keep': ('v.', '保持'),
 'kid': ('n.', '孩子'), 'kind': ('adj.', '友善的'), 'lead': ('v.', '引领'),
 'lean': ('v.', '倚靠'), 'leave': ('v.', '离开'), 'like': ('v.', '喜欢'),
 'line': ('n.', '线'), 'list': ('n.', '清单'), 'live': ('v.', '居住'),
 'local': ('adj.', '当地的'), 'look': ('v.', '看'), 'lot': ('n.', '大量'),
 'low': ('adj.', '低的'), 'major': ('adj.', '主要的'), 'many': ('det.', '许多'),
 'may': ('aux.', '可能'), 'mean': ('v.', '意味着'), 'medical': ('adj.', '医学的'),
 'meet': ('v.', '遇见'), 'might': ('aux.', '可能'), 'mind': ('n.', '头脑'),
 'military': ('adj.', '军事的'), 'minute': ('n.', '分钟'), 'much': ('det.', '许多'),
 'natural': ('adj.', '自然的'), 'nothing': ('pron.', '没有什么'),
 'offer': ('v.', '提供'), 'old': ('adj.', '年老的'), 'only': ('adv.', '仅仅'),
 'open': ('v.', '打开'), 'over': ('prep.', '在…上方'), 'panel': ('n.', '小组'),
 'particular': ('adj.', '特定的'), 'pay': ('v.', '支付'),
 'performance': ('n.', '表现'), 'perspective': ('n.', '视角'),
 'plane': ('n.', '飞机'), 'play': ('v.', '玩'), 'player': ('n.', '选手'),
 'press': ('v.', '按'), 'pressure': ('n.', '压力'), 'prime': ('adj.', '主要的'),
 'process': ('n.', '过程'), 'produce': ('v.', '生产'),
 'program': ('n.', '程序'), 'project': ('n.', '项目'),
 'public': ('adj.', '公共的'), 'pursue': ('v.', '追求'),
 'raise': ('v.', '提高'), 'reach': ('v.', '到达'), 'ready': ('adj.', '准备好的'),
 'realize': ('v.', '意识到'), 'relate': ('v.', '联系'), 'remove': ('v.', '移除'),
 'represent': ('v.', '代表'), 'rice': ('n.', '米饭'), 'risk': ('n.', '风险'),
 'ruler': ('n.', '尺子'), 'safe': ('adj.', '安全的'), 'save': ('v.', '保存'),
 'scene': ('n.', '场景'), 'second': ('num.', '第二'), 'section': ('n.', '部分'),
 'seem': ('v.', '似乎'), 'sense': ('n.', '感觉'), 'separate': ('adj.', '单独的'),
 'series': ('n.', '系列'), 'set': ('v.', '设置'), 'settle': ('v.', '定居'),
 'several': ('det.', '几个'), 'share': ('v.', '分享'), 'show': ('v.', '展示'),
 'site': ('n.', '地点'), 'sleep': ('v.', '睡觉'), 'space': ('n.', '空间'),
 'special': ('adj.', '特殊的'), 'start': ('v.', '开始'), 'state': ('n.', '状态'),
 'still': ('adv.', '仍然'), 'stir': ('v.', '搅动'), 'stock': ('n.', '股票'),
 'supreme': ('adj.', '至高的'), 'survive': ('v.', '生存'),
 'tend': ('v.', '倾向于'), 'the': ('art.', '特指的人或事物'),
 'threat': ('n.', '威胁'), 'truth': ('n.', '真相'), 'various': ('adj.', '各种各样的'),
 'very': ('adv.', '非常'), 'want': ('v.', '想要'), 'way': ('n.', '方式'),
 'well': ('adv.', '很好'), 'while': ('conj.', '当…时候'),
 'will': ('aux.', '将要'), 'within': ('prep.', '在…之内'),
 'wonder': ('v.', '想知道'), 'would': ('aux.', '将会'),
}

SPECS = [
 ('primary', '小学英语', '基础起步', '基础', '01', None, '#F0BD73'),
 ('junior', '初中英语', '中考标签精选', '基础', '02', 'zk', '#A9BDB0'),
 ('senior', '高中英语', '高考标签精选', '基础', '03', 'gk', '#97A8BD'),
 ('cet4', '大学四级', 'CET-4 标签精选', '大学', '04', 'cet4', '#B9C4A5'),
 ('cet6', '大学六级', 'CET-6 标签精选', '大学', '05', 'cet6', '#BAA8BF'),
 ('postgraduate', '考研英语', '考研标签精选', '大学', '06', 'ky', '#BEA48A'),
 ('ielts', '雅思 IELTS', 'IELTS 标签精选', '留学', '07', 'ielts', '#87AEB2'),
 ('toefl', '托福 TOEFL', 'TOEFL 标签精选', '留学', '08', 'toefl', '#92A0C2'),
 ('gre', 'GRE', 'GRE 标签精选', '留学', '09', 'gre', '#B1AF91'),
 ('sat', 'SAT', '待补充授权词表', '留学', '10', None, '#D3C6B7'),
]

def dump(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n')

def split_meanings(translation):
    # ECDICT uses literal backslash+n rather than real line breaks in fields.
    lines = translation.replace('\\n', '\n').splitlines()
    result = []
    for line in lines:
        line = re.sub(r'\[[^]]*\]', '', line).strip()
        if not line:
            continue
        match = re.match(r'^([a-z]+\.)\s*(.*)', line)
        pos, body = (match.group(1), match.group(2)) if match else ('', line)
        pos = {'a.': 'adj.', 'ad.': 'adv.', 'vt.': 'v.', 'vi.': 'v.'}.get(pos, pos)
        for part in re.split(r'[,，;；]', body):
            meaning = part.strip().strip('"')
            if meaning and re.search(r'[\u4e00-\u9fff]', meaning) and len(meaning) <= 38 and not meaning.startswith('='):
                result.append({'pos': pos, 'meaning': meaning})
    seen = set()
    return [item for item in result if not (item['meaning'] in seen or seen.add(item['meaning']))][:8]

def main():
    path = Path(sys.argv[1])
    raw = path.read_bytes()
    blob = hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest()
    if blob != BLOB:
        raise SystemExit('Upstream CSV hash mismatch; expected ' + BLOB + ', got ' + blob)
    entries = {}
    tag_counts = {}
    with path.open(encoding='utf-8') as handle:
        for row in csv.DictReader(handle):
            word = row['word']
            if not re.fullmatch(r'[a-z]+(?:[-\x27][a-z]+)?', word):
                continue
            meanings = split_meanings(row['translation'])
            if not meanings:
                continue
            tags = row['tag'].split()
            for tag in tags:
                tag_counts[tag] = tag_counts.get(tag, 0) + 1
            row['meanings'] = meanings
            row['tags'] = tags
            row['rank'] = int(row['frq']) if row['frq'].isdigit() and int(row['frq']) > 0 else int(row['bnc']) if row['bnc'].isdigit() and int(row['bnc']) > 0 else 999999
            entries[word] = row
    selected = set()
    books = []
    full_ids = {}
    for bid, title, subtitle, category, level, tag, color in SPECS:
        if bid == 'sat':
            candidates = []
        elif bid == 'primary':
            candidates = [word for word in PRIMARY if word in entries]
        else:
            candidates = [word for word, row in entries.items() if tag in row['tags']]
            candidates.sort(key=lambda word: entries[word]['rank'])
            editorial = [word for word in CURATED if word in entries and tag in entries[word]['tags']]
            candidates = editorial + [word for word in candidates if word not in editorial]
        chosen = candidates[:180]
        full_ids[bid] = candidates
        selected.update(chosen)
        books.append({'id': bid, 'title': title, 'subtitle': subtitle, 'category': category,
                      'level': level, 'wordIds': chosen, 'count': len(chosen), 'selectedCount': len(chosen),
                      'fullCount': len(candidates), 'available': bool(chosen), 'coverColor': color,
                      'selection': '人工基础选词' if bid == 'primary' else 'ECDICT 考试标签词频精选' if tag else '待补充',
                      'isComplete': False, 'fullAvailable': bool(candidates), 'edition': 'selected'})

    def make_word(word, book_ids=None):
        row = entries[word]
        meanings = row['meanings']
        curated = CURATED.get(word)
        override = CORE_OVERRIDES.get(word)
        core = {'pos': curated[0], 'meaning': curated[1]} if curated else {'pos': override[0], 'meaning': override[1]} if override else meanings[0]
        # Obsolete and misleading first senses are not useful learning material.
        if word == 'natural':
            meanings = [item for item in meanings if item['meaning'] != '白痴']
        if curated or override:
            meanings = [core] + [item for item in meanings if item['meaning'] != core['meaning']]
        return {'id': word, 'word': word,
                      'phonetic': row['phonetic'].replace('ә', 'ə').replace("'", 'ˈ'),
                      'pos': core['pos'], 'coreMeaning': core['meaning'],
                      'meanings': meanings[:8],
                      'example': {'en': curated[2], 'zh': curated[3]} if curated else None,
                      'bookIds': book_ids or [book['id'] for book in books if word in book['wordIds']],
                      'source': 'ECDICT · MIT' + (' / 核心义与例句原创编辑' if curated else ' / 核心义原创编辑' if override else ' / 首义提取')}

    words = [make_word(word) for word in sorted(selected)]
    output = "'use strict';\n// Generated by scripts/build-vocabulary.py. See ECDICT-LICENSE.txt.\nconst words = " + json.dumps(words, ensure_ascii=False, separators=(',', ':')) + ';\nconst books = ' + json.dumps(books, ensure_ascii=False, separators=(',', ':')) + ';\nconst wordMap = Object.create(null);\nwords.forEach(word => { wordMap[word.id] = word; });\nmodule.exports = { words, books, wordMap };\n'
    (ROOT / 'data' / 'vocabulary.js').write_text(output)
    for book in books:
        dump(ROOT / 'data' / 'books' / (book['id'] + '.json'), {'book': book, 'words': [next(item for item in words if item['id'] == wid) for wid in book['wordIds']]})
    full_dir = ROOT / 'data' / 'full-books'
    full_dir.mkdir(parents=True, exist_ok=True)
    full_bytes = 0
    for book in books:
        if not book['available']:
            continue
        full_book = dict(book)
        full_book.update({'wordIds': full_ids[book['id']], 'count': len(full_ids[book['id']]),
                          'edition': 'full', 'subtitle': book['subtitle'].replace('精选', '词表'),
                          'selection': '人工基础选词' if book['id'] == 'primary' else 'ECDICT 考试标签全量（非官方大纲）'})
        full_words = []
        for word in full_book['wordIds']:
            entry = make_word(word, [book['id']])
            lean = {key: entry[key] for key in ['id', 'phonetic', 'pos', 'coreMeaning', 'meanings']}
            # Four alternative senses suffice in the expandable card. Saving
            # redundant text keeps even GRE comfortably cacheable on WeChat.
            lean['meanings'] = lean['meanings'][:5]
            if entry['example']:
                lean['example'] = entry['example']
            full_words.append(lean)
        target = full_dir / (book['id'] + '.json')
        dump(target, {'book': full_book, 'words': full_words,
                      'source': SOURCE_URL, 'upstreamBlobSha1': BLOB,
                      'license': (ROOT / 'data' / 'ECDICT-LICENSE.txt').read_text()})
        full_bytes += target.stat().st_size
    dump(ROOT / 'data' / 'provenance.json', {
        'source': SOURCE_URL, 'license': 'MIT', 'licenseFile': 'ECDICT-LICENSE.txt',
        'upstreamBlobSha1': BLOB, 'upstreamCsvBytes': len(raw),
        'selectedUniqueWords': len(words), 'vocabularyBytes': len(output.encode()),
        'fullBooksBytes': full_bytes,
        'selectionMethod': '每本取最多180个合法英文词，原创编辑词条优先，余按上游frq/bnc排序；小学人工选词；SAT未开放。',
        'coreMeaningMethod': str(sum(1 for word in selected if word in CURATED or word in CORE_OVERRIDES)) + '个原创编辑核心义，其余取上游首条中文义项；未声称统计最高频义，仍需持续校订。',
        'books': [{'id': book['id'], 'count': book['count'], 'upstreamFilteredCount': book['fullCount'], 'available': book['available']} for book in books],
        'limitations': ['内置精选体验词库；完整包覆盖上游对应标签词表，均不是官方完整考试大纲，上游标签可能滞后。', '仅上游英式音标，无录音；例句只有原创编辑的条目提供。', 'ECDICT上游聚合多个历史词典与语料；商业正式发布应进一步审核逐项数据来源。']
    })
    print(json.dumps({'uniqueWords': len(words), 'bytes': len(output.encode()), 'fullBooksBytes': full_bytes, 'books': {book['id']: book['count'] for book in books}}, ensure_ascii=False))

if __name__ == '__main__':
    main()
