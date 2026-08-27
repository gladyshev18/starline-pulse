import { describe, expect, it } from 'vitest'
import { looksLikeFuelReceipt, parseFiscalLink, parseFuelLineItem, parseReceiptDate, parseReceiptMail, parseReceiptText, parseTotalAmount, stripHtml } from '../receipts/parsers'
import { matchesSenderAllowlist, parseForwardedSenders, type ReceiptMailMessage } from '../receipts/mail/types'

function mail(values: Partial<ReceiptMailMessage>): ReceiptMailMessage {
  return {
    uid: 1,
    messageId: '<1@ofd>',
    addresses: ['noreply@platformaofd.ru'],
    subject: '',
    date: new Date('2026-08-14T07:35:00.000Z'),
    text: '',
    html: null,
    attachments: [],
    ...values
  }
}

describe('parseReceiptDate', () => {
  it('reads a printed Moscow date', () => {
    expect(parseReceiptDate('Дата 14.08.2026 10:30')?.toISOString()).toBe('2026-08-14T07:30:00.000Z')
  })

  it('reads a date with seconds', () => {
    expect(parseReceiptDate('14.08.2026, 10:30:45')?.toISOString()).toBe('2026-08-14T07:30:45.000Z')
  })

  it('gives up on text without a date', () => {
    expect(parseReceiptDate('Спасибо за покупку')).toBeNull()
  })
})

describe('parseFiscalLink', () => {
  it('pulls the check payload out of a link', () => {
    const parsed = parseFiscalLink('Проверить: https://check.ofd.ru/rec?t=20260814T1030&s=2530.00&fp=123456')
    expect(parsed?.totalAmount).toBe(2530)
    expect(parsed?.purchasedAt.toISOString()).toBe('2026-08-14T07:30:00.000Z')
  })

  it('ignores an ordinary link', () => {
    expect(parseFiscalLink('https://example.com/promo?utm=mail')).toBeNull()
  })
})

describe('stripHtml', () => {
  it('keeps a table row on one line even when the markup wraps across sources lines', () => {
    const rows = stripHtml([
      '<tr>',
      '  <td align="left"',
      '      valign="top">Адрес расчетов</td>',
      '  <td align="right">392013, РОССИЯ, г. Тамбов</td>',
      '</tr>'
    ].join('\n')).split('\n').filter(Boolean)

    expect(rows).toEqual(['Адрес расчетов 392013, РОССИЯ, г. Тамбов'])
  })

  it('turns a table into readable lines and drops scripts', () => {
    const text = stripHtml('<style>.a{}</style><table><tr><td>АИ-95</td><td>38,42 л</td></tr></table><script>alert(1)</script>')
    expect(text).toContain('АИ-95')
    expect(text).toContain('38,42 л')
    expect(text).not.toContain('alert')
  })
})

describe('parseReceiptText', () => {
  it('reads the litres even when nothing else can imply them', () => {
    expect(parseReceiptText('Отпущено 38,42 л').litres).toBe(38.42)
    expect(parseReceiptText('Объём: 40,00 литров').litres).toBe(40)
  })

  it('reads a plain fuel receipt', () => {
    const parsed = parseReceiptText([
      'АЗС Роснефть №241, Москва, Ленинский пр-т 100',
      'ИНН 7706107510',
      '14.08.2026 10:30',
      'АИ-95  38,42 л  x  65,50 руб/л',
      'ИТОГО: 2 516,51'
    ].join('\n'))

    expect(parsed).toMatchObject({
      station: 'rosneft',
      fuelType: 'АИ-95',
      litres: 38.42,
      pricePerLitre: 65.5,
      totalAmount: 2516.51,
      sellerInn: '7706107510'
    })
    expect(parsed.purchasedAt?.toISOString()).toBe('2026-08-14T07:30:00.000Z')
  })

  it('prefers the fiscal link over the printed numbers', () => {
    const parsed = parseReceiptText('Итого: 100,00\nhttps://check.ofd.ru/rec?t=20260814T1030&s=2530.00&fp=99&i=17')
    expect(parsed).toMatchObject({ totalAmount: 2530, fiscalDocNumber: '17', fiscalSign: '99' })
  })

  it('derives the missing litres from the total and the price', () => {
    const parsed = parseReceiptText('Цена 65,00\nК оплате 2 600,00')
    expect(parsed).toMatchObject({ pricePerLitre: 65, totalAmount: 2600, litres: 40 })
  })

  it('tells a refund apart from the purchase it reverses', () => {
    const lines = [
      'Кассовый чек.',
      'Приход',
      'Смена №: 347 Чек №: 79',
      '27.08.2026 09:22',
      '1. АИ-95-К5 N 3:00000  69.75  25  1743.75',
      'ИТОГО: 1743.75'
    ]
    expect(parseReceiptText(lines.join('\n'))).toMatchObject({ operation: 'purchase', litres: 25, totalAmount: 1743.75 })

    const refund = parseReceiptText(lines
      .map(line => line === 'Приход' ? 'Возврат прихода' : line)
      .map(line => line.replace('69.75  25  1743.75', '69.75  0.79  55.10').replace('ИТОГО: 1743.75', 'ИТОГО: 55.10'))
      .join('\n'))
    // The figures stay exactly as printed: only the operation says which way
    // the fuel went, and the subtraction happens where receipts are summed.
    expect(refund).toMatchObject({ operation: 'refund', litres: 0.79, totalAmount: 55.1 })
  })

  it('recognises Lukoil', () => {
    expect(parseReceiptText('ООО "ЛУКОЙЛ-Центрнефтепродукт"').station).toBe('lukoil')
  })

  it('returns empty values for an unrelated letter', () => {
    const parsed = parseReceiptText('Ваш заказ доставлен, спасибо за покупку')
    expect(parsed).toMatchObject({ litres: null, totalAmount: null, purchasedAt: null, station: null })
  })
})

// Shape of a real "Первый ОФД" letter for a Rosneft station, hand-forwarded from
// Mail.ru. Personal data and fiscal identifiers are replaced with stand-ins.
const rosneftLetter = [
  'Отправлено из мобильной Почты Mail.ru',
  '',
  '-------- Пересылаемое сообщение --------',
  'От: Чек и подарок <echeck@1-ofd.ru>',
  'Кому: <buyer@example.com>',
  'Дата: суббота, 15 августа 2026 г. в 10:13 +03:00',
  'Тема: АО "ВОРОНЕЖНЕФТЕПРОДУКТ" 15.08.2026 10:10',
  '',
  '> Получить кэшбэк за этот чек (',
  '> https://ecl.1-ofd.ru/e/mailcb?template=receiptRosneft_0t_new_july&inn=3664002554',
  '> &fn=7300000000000000&doc=90000.00 )',
  '>',
  '> АО "ВОРОНЕЖНЕФТЕПРОДУКТ"',
  '> ИНН: 3664002554',
  '> АЗК №322 Тамбовская область, муниципальный округ Моршанский, поселок',
  '> Пригородный, улица Кузнецова, дом 1д',
  '> Тамбовская область, муниципальный округ Моршанский, поселок Пригородный,',
  '> улица Кузнецова, дом 1д',
  '>',
  '>  Кассовый чек. Приход',
  '> --------------------',
  '>',
  '> Смена №: 336',
  '> Чек №: 176',
  '> 15.08.2026 10:10',
  '> № Наименование Цена за ед. Кол. Сумма 1. АИ-92-К5 N 2:00000 64.25 20 1285.00',
  '> Подакцизный товар Полный расчет НДС 22% СУММА НДС 22% 231.72 ИТОГО: 1285.00',
  '> Безналичными 1285.00 Применяемая система налогообложения ОСН',
  '> РН ККТ: 0000000000000000',
  '> № ФД: 90000',
  '> № ФН: 7300000000000000',
  '> ФПД: 700000000',
  '>',
  '> Открыть чек в браузере (',
  '> https://consumer.1-ofd.ru/v1?t=20260815T101000&s=1285&fn=7300000000000000&i=90000&fp=700000000&n=1',
  '> )'
].join('\n')

describe('a Rosneft receipt from Первый ОФД', () => {
  it('reads every figure the receipt prints', () => {
    const parsed = parseReceiptText(rosneftLetter)

    expect(parsed).toMatchObject({
      station: 'rosneft',
      fuelType: 'АИ-92',
      litres: 20,
      pricePerLitre: 64.25,
      totalAmount: 1285,
      sellerInn: '3664002554',
      fiscalDocNumber: '90000',
      fiscalSign: '700000000'
    })
    expect(parsed.purchasedAt?.toISOString()).toBe('2026-08-15T07:10:00.000Z')
  })

  it('joins the address split across wrapped lines and drops the repeat', () => {
    expect(parseReceiptText(rosneftLetter).address)
      .toBe('АЗК №322 Тамбовская область, муниципальный округ Моршанский, поселок Пригородный, улица Кузнецова, дом 1д')
  })

  it('finds the sender that hand-forwarding left only in the body', () => {
    expect(parseForwardedSenders(rosneftLetter)).toEqual(['echeck@1-ofd.ru'])
    expect(matchesSenderAllowlist(parseForwardedSenders(rosneftLetter), ['1-ofd.ru'])).toBe(true)
  })
})

// Shape of a real "ОФД-Я" letter for a Lukoil station: HTML only, the figures on
// their own line, and the address behind a label. Personal data is replaced.
const lukoilReceipt = [
  'Кассовый чек',
  'Приход',
  'Торговый зал',
  '01.12.2024 06:26 № 130000',
  'ТРК №2 Бензин автомобильный ЭКТО Plus (АИ-95-К5)',
  '41.38 x 61.26 = 2534.94',
  'НДС 20%',
  'ИТОГО 2534.94',
  'Безналичными 2534.94',
  'Пользователь ООО "ЛУКОЙЛ-Центрнефтепродукт"',
  'ИНН 7701285928',
  'Адрес расчетов 392013, РОССИЯ, Тамбовская обл., г. Тамбов, ул. Чичерина, 5',
  'Место расчетов Торговый зал',
  'Дата выдачи ФД 01.12.2024 06:26',
  'ФД 130000',
  'Кассир Оператор АЗС',
  'ФН 7300000000000000',
  'ФПД 4200000000',
  'Версия ФФД 1.2',
  'Адрес электронной почты отправителя чека: azs00000@lukoil.com'
].join('\n')

describe('a Lukoil receipt from ОФД-Я', () => {
  it('reads the figures printed on their own line as "41.38 x 61.26 = 2534.94"', () => {
    expect(parseReceiptText(lukoilReceipt)).toMatchObject({
      station: 'lukoil',
      fuelType: 'АИ-95',
      litres: 41.38,
      pricePerLitre: 61.26,
      totalAmount: 2534.94,
      sellerInn: '7701285928'
    })
  })

  it('takes the receipt number and not the date printed above it as the document number', () => {
    expect(parseReceiptText(lukoilReceipt)).toMatchObject({ fiscalDocNumber: '130000', fiscalSign: '4200000000' })
  })

  it('reads the labelled address and ignores the sender mailbox under a similar label', () => {
    expect(parseReceiptText(lukoilReceipt).address)
      .toBe('392013, РОССИЯ, Тамбовская обл., г. Тамбов, ул. Чичерина, 5')
  })
})

// Shape of a real "Первый ОФД" letter for a Rostelecom payment: the same
// operator, the same layout, nothing to do with fuel. Personal data and fiscal
// identifiers are replaced with stand-ins.
const rostelecomLetter = [
  'ПАО "РОСТЕЛЕКОМ"',
  'ИНН: 7707049388',
  '109316, Москва, Волгоградский проспект, 42, к 9',
  'Кассовый чек. Приход',
  'Смена №: 63',
  'Чек №: 858',
  '20.08.2026 09:44',
  'ККТ для интернет',
  '№ Наименование Цена за ед. Кол. Сумма',
  '1. Аванс за услуги связи: 70000000000 275.15 1 275.15',
  'Платеж Аванс НДС 22/122',
  'СУММА НДС 22/122 49.62',
  'ИТОГО: 275.15',
  'Безналичными 275.15',
  '№ ФД: 127468',
  'ФПД: 4000000000'
].join('\n')

describe('parseTotalAmount', () => {
  it('takes the printed total and not the column header with the row number under it', () => {
    expect(parseTotalAmount('Цена за ед. Кол. Сумма\n1. Аванс 275.15 1 275.15\nИТОГО: 275.15')).toBe(275.15)
  })

  it('never reads the total out of the tax line', () => {
    expect(parseTotalAmount('СУММА НДС 22% 231.72')).toBeNull()
  })

  it('refuses the bare column header when nothing else is labelled', () => {
    expect(parseTotalAmount('Цена за ед. Кол. Сумма\n1. Кофе 120.00')).toBeNull()
  })

  it('still reads a total labelled every ordinary way', () => {
    expect(parseTotalAmount('ИТОГО 2534.94')).toBe(2534.94)
    expect(parseTotalAmount('К оплате 2 600,00')).toBe(2600)
    expect(parseTotalAmount('Сумма: 1 285,00')).toBe(1285)
  })
})

describe('looksLikeFuelReceipt', () => {
  it('accepts the receipts of both chains', () => {
    for (const letter of [rosneftLetter, lukoilReceipt]) {
      expect(looksLikeFuelReceipt(letter, parseReceiptText(letter))).toBe(true)
    }
  })

  it('rejects a phone bill that arrived from the very same operator', () => {
    expect(looksLikeFuelReceipt(rostelecomLetter, parseReceiptText(rostelecomLetter))).toBe(false)
  })

  it('accepts a receipt that names the fuel without naming a chain', () => {
    const text = 'Кассовый чек\nДТ-К5 40.00 x 62.10 = 2484.00'
    expect(looksLikeFuelReceipt(text, parseReceiptText(text))).toBe(true)
  })
})

describe('a Rostelecom receipt that shares the operator with the fuel ones', () => {
  it('reads the printed total rather than the row number beside the column header', () => {
    expect(parseReceiptText(rostelecomLetter).totalAmount).toBe(275.15)
  })

  it('finds no fuel in it', () => {
    expect(parseReceiptText(rostelecomLetter)).toMatchObject({ station: null, fuelType: null, litres: null })
  })
})

describe('parseFuelLineItem', () => {
  it('recognises the price, volume and total with no units printed', () => {
    expect(parseFuelLineItem('1. АИ-92-К5 N 2:00000 64.25 20 1285.00'))
      .toEqual({ pricePerLitre: 64.25, litres: 20, totalAmount: 1285 })
  })

  it('reads a line that puts the volume before the price', () => {
    expect(parseFuelLineItem('АИ-95 38.42 65.50 2516.51'))
      .toEqual({ pricePerLitre: 65.5, litres: 38.42, totalAmount: 2516.51 })
  })

  it('refuses numbers that do not multiply out', () => {
    expect(parseFuelLineItem('АИ-95 колонка 3 смена 336 чек 176')).toBeNull()
  })

  it('ignores a line without a fuel grade', () => {
    expect(parseFuelLineItem('Кофе 1 120.00 120.00')).toBeNull()
  })
})

describe('parseReceiptMail', () => {
  it('reads figures out of an HTML letter', () => {
    const parsed = parseReceiptMail(mail({
      subject: 'Электронный чек АЗС',
      html: '<p>Роснефть</p><p>14.08.2026 10:30</p><p>АИ-95 — 38,42 л</p><p>Итого: 2 516,51</p>'
    }))
    expect(parsed).toMatchObject({ station: 'rosneft', litres: 38.42, totalAmount: 2516.51 })
  })

  it('falls back to the delivery time when the letter prints no date', () => {
    const parsed = parseReceiptMail(mail({ text: 'Итого: 1 000,00' }))
    expect(parsed.purchasedAt?.toISOString()).toBe('2026-08-14T07:35:00.000Z')
  })
})
