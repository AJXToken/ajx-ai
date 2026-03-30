montako tuntia rajat 800 viestiä ja 2000 viestiä on kk= kestää

kuville oma paikka= myöhemmin jos ikinä

varmuuskopio

kielivalinta=valmis

puheominaisuus

webominaisuus ei ole päällä

plus nappula liitteille ja kuville jne

tehdään ajc focus - business partner. puuttuu partner ominaisuus ja nappula 19.99E/KK

Lite tasolle tulee maksu mahdollisuus ajxtokenilla ja käyttö lisenssin saa siihen 2 vuodeksi

myös koodia varten pitää olla kopiointi nappula valmiina ja oma laatikko koodilla. kuten chat gpt on homman ratkaissut

tarkista rajat, free 10, lite 800, Basic 800, pro ja b partner 400 plus 1600



\---



1\. Huomio! viesti merkki raja olisi hyvä niin ettei viestittely tule helvetin kalliiksi. eli koodareille ja heavy usereille rajat.

Lisätään koodiin varmistus (fallback), jos Gemini on alhaalla tai antaa virheen (esim. Overloaded).



Logiikka koodiin:



Yritä Geminiä (2.5 Flash Lite / Flash / Pro).



Jos tulee virhekoodi 500, 503 tai "Quota exceeded":



Vaihda malliksi GPT-4o-mini (halvin ja nopein vastaava).



2\. Company tuotteen mallin pudottaminen 400 viestin jälkeen on täysin kriittinen ominaisuus. Context cachingin käyttö 75 viestin muistilla on pakollista, jotta historia ei syö marginaalia nollaan loppukuusta.



3\. chatin pääkohtaisena luonteena voisi olla kuin chat gpteellä: kohtelias, ystävällinen, empaattinen, miellyttävä, asiallinen, kannustava, hieman imarteleva.



4\. Tarlosta vielä addons/buy route, jotta Basicin lisäpaketti-teksti ja logiikka vastaavat tätä uutta mallia täysin.



5\. tuote on suunnattu yrittäjille, freelancereille ja rakentajille. Heille pitäisi saada lisänappeja joista he voisivat nopeasti valita esimerkiksi: analysoi liike-ideani, luo liikentoimintastrategia, löydä markkinointi ideoita… tai jotain tämän kaltaisia



6\. landing page



7\. mobiiliystävällinen



8\. jäsentele vastaukset paremmin

 	-käytä selkeitä otsikoita

 	-käytä numeroituja listoja

 	-vältä pitkiä tekstikappaleita

 	-tee vastauksista helposti luottavia



9\. ota aina huomioon että ajx ai toimii samalla tavalla kolmella eri kielellä eli suomi, englanti ja espanja



10\. tällä hetkellä meillä on pikanapit paranna liike toimintaa, kasvata tuloja, strategia, markkinointi, hinnoittelu, tarjous. napit pitäisi toimia siten että ensin ai kysyy muutaman tarkentavan kysymyksen ja sen jälkeen antaa vastauksen. samoin myös kun käyttäjä valitsee agentin.



11\. enter nappula (rivinvaihto)



12\. pitäisi tehdä turva varmistus että ai ei ala toimimaan terapeuttina. ajx ai on luotu työkaluksi. ei seurustelukumppaniksi, samoin pitäisi tehdä jokin muistutus että vastauksia ei suoraan käyttää liiketoimintaan. että käyttäjän vastuulla ja ajx ai ei ota vastuuta jos bisnekset kusee sen takia. joka 20 viesti jokin muistutus ja heti alkuun. haluan varmistaa että en mene konkurssiin tämän bisneksen takia kun joku kyrpä ryssii omat bisnekset tämän takia

\---

**Asiat, jotka näyttävät nyt olevan kunnossa**

**Kunnossa**



hinnat



agenttijako



viestirajat



work memory -rajat



web boost Pro/Company



Companyn mallipudotus 400 jälkeen



turvallisuusrajat route:ssa



vastausten jäsentelyohjeet route:ssa



lisäpakettien tallennus usageen



stats-routet päivitetty logiikkaan



image route päivitetty lisägenerointeihin



chat route päivitetty lisäanalyysien käyttöön



**Kohdat, jotka ovat vielä tarkistuslistalla**



ohje osio jotta käyttäjät osaa käyttää tätä tuotetta



1\. Kolmen kielen täydellinen auditointi



Backendissä paljon on jo linjassa, mutta koko UI ei välttämättä vielä ole.



2\. Landing page



Ei tämän keskustelun perusteella vielä valmis / auditoitu.



3\. Context caching



work memory on tehty



oikea provider-tason context caching pitää vielä erikseen varmistaa



4\. UI-tekstit ja add-on näkyvyys



Pitää vielä varmistaa, että frontend näyttää juuri nämä samat tuotteet oikein.



20\. Yksi tärkeä huomio ristiriidasta



Sinun vanhemmissa muisteissa on myös vanha lukittu AJX AI -hinnoitteluspeksejä, joissa esiintyy esim.



Visual



vanhat message-määrät



vanhat muistimäärät



Mutta tässä keskustelussa korjattu nykyinen käytössä oleva malli on tämä:



Free



Basic



Plus



Pro



Company



ja näillä tämän viestin rajoilla.



Eli käytännössä tätä kannattaa pitää nyt uusimpana aktiivisena tuotteistuksena, jos koodi on vaihdettu näiden mukaan.

\---

Geminimallit:

Keskeiset Gemini-malliversiot (1.5-sarja)

Gemini 1.5 Pro: Tasapainoinen malli, joka on suunniteltu suorituskykyiseksi monenlaisissa tehtävissä. Se sopii hyvin monimutkaiseen päättelyyn, koodaukseen ja suurten tietomäärien analysointiin.

Gemini 1.5 Flash: Kevyt ja erittäin nopea malli, joka on optimoitu suuren volyymin ja matalan viiveen tehtäviin, kuten reaaliaikaisiin chatbotteihin ja videoiden/dokumenttien tiivistämiseen.

Gemini 1.5 Flash-Lite: Vieläkin nopeampi ja kustannustehokkaampi versio, joka on tarkoitettu kevyempiin tekoälysovelluksiin.

Gemini 3 (ja uudemmat): Tuoreimmat versiot, kuten Gemini 3 Deep Think, keskittyvät syvälliseen päättelyyn, agenttimaiseen toimintaan ja monivaiheisten monimutkaisten tehtävien ratkaisemiseen.

Gemini Nano: Pienin malli, joka on suunniteltu toimimaan suoraan laitteessa, kuten älypuhelimessa, ilman internet-yhteyttä.



MalliHinta / 1M tokenia (Input/Output keskiarvo)Kustannus (800 viestiä/kk)

SoveltuvuusGemini 1.5 Pron. $3,10n. 2,90 €"Aivot": koodaus, monimutkainen päättely.

Gemini 1.5 Flashn. $0,20n. 0,19 €"Työjuhta": nopea, yleiskäyttöinen, halpa.

Gemini 1.5 Flash-Liten. $0,15n. 0,14 €"Säästäjä": hyvin yksinkertaiset tehtävät.







\---







💰 AJX AI – Hinnasto

⚪ Free – 0 €

kaikki kuvat generoidaan: - Gemini 2.5 Flash Image



Kevyt demo kokeiluun.



Käyttö



Rajoitettu määrä pyyntöjä 20 / vrk



Teksti = 1 pyyntö

Kuva + kysymys = 2 pyyntöä (tämä sääntö myös muilla tasoilla)



Web-haut: Ei käytössä



Muisti



5 viestin työmuisti



ei kuva generointia



Malli



Gemini 2.5 Flash lite



Agentit



Yleinen



👉 rooli on auttaa yleisellä tasolla. ei turhan pitkiä vastauksia. lyhyt ja ytimekäs



🟡 Basic – 3,99 € / kk



Kevyt arjen AI – chat + kuvat.



Käyttö



1000 pyyntöä / kk

(sisältää 5 kuva-analyysiä / vrk)

1 kuvan generointi / vrk



Web-haut: Ei sisälly



Muisti



10 viestin työmuisti



Malli



Gemini 2.5 Flash lite



Agentit



Yleinen

tiedonhaku



Lisäpaketti



+500 pyyntöä

+5 analyysiä / vrk

1 kuvan generointi / vrk

3,99 €

(voimassa kuluvan kuukauden)



👉 rooli on hakea tietoa. pidemmät vastaukset kuin roolilla yleinen.



🔵 Plus – 9,99 € / kk



Agentti nimi Ideointi



Käyttö



1000 viestiä / kk

120 kuva-analyysiä / kk

2 kuvan luontia / vrk



Web-haut: Ei sisälly



Muisti



15 viestin työmuisti



Malli



Gemini 2.5 Flash lite



Agentit



Yleinen

tiedonhaku

Ideointi



Lisäpaketit



+1000 viestiä \& 120 analyysiä – 9,99 €

Web Mini – 50 web-hakua / kk – 3,99 €

(voimassa kuluvan kuukauden)



👉 rooli on auttaa ideoinnissa ja viedä asioita eteenpäin



🟣 Pro – 19,99 € / kk



agentti nimi analysointi



Käyttö



3000 viestiä / kk

200 kuva-analyysiä / kk

100 kuvan luontia / kk

200 web-hakua / kk



Muisti



50 viestin työmuisti



Malli



Gemini 2.5 Flash





Agentit



Yleinen

tiedonhaku

Ideointi

Analysointi



Lisäpaketit



+3000 viestiä

+200 kuva-analyysiä

+100 kuvan luontia

19,99 €



Web Boost – +200 web-hakua – 4,90 €

(voimassa kuluvan kuukauden)



👉 Pro on analysointiin ja tuottamaan tulosta.



🔴 Company – 29,99 € / kk



Strateginen kumppani päätöksentukeen.



agentti nimi on strategia





Käyttö



ensimmäiset 400 viestiä Gemini 2.5 pro jonka jälkeen tippuu tasolle Gemini 2.5 Flash

4000 viestiä / kk

300 kuva-analyysiä / kk

150 kuvan luontia / kk

300 web-hakua / kk



Muisti



75 viestin työmuisti

Context caching pitkille ketjuille



Malli



Gemini 2.5 pro ja Gemini 2.5 flash



Agentit



Yleinen

tiedonhaku

Ideointi

Analysointi

Strategia



Lisäpaketit



+4000 viestiä

+300 kuva-analyysiä

+150 kuvan luontia

29,99 €



Web Boost – +200 web-hakua – 4,90 €

(voimassa kuluvan kuukauden)



👉 AI, joka uskaltaa olla eri mieltä ja auttaa suunnan valinnassa.



Selkeä. Työorientoitunut. Ei turhaa kohteliaisuutta.



⚠️ AJX AI Disclaimer



AJX AI on tekoälypohjainen työkalu. Vastaukset ovat viitteellisiä ja ne tulee aina tarkistaa asiantuntijalla. AJX AI ei vastaa annettujen neuvojen perusteella tehdyistä päätöksistä tai niiden seurauksista. Käyttäjä on vastuussa AI:n tuottaman sisällön käytöstä.



AI voi tuottaa virheellistä tietoa.



kaikki kuvat Imagen 3 Fast tasoisia. Pakota resoluutio ja laatu

Älä anna AI:n päättää kuvan kokoa. Kiinnitä se koodissa Standard-tasolle (esim. 1024x1024). Estä mallia generoimasta useampaa kuin 1 kuva per vastaus



web hauissa käytetään Dynamic Retrieval" -asetusta. Se tarkistaa ensin, onko vastaus jo mallin tiedossa, ja tekee maksullisen haun vain, jos se on välttämätöntä. Mutta jos käyttäjä maksaa Web-boostista, on reiluinta pakottaa haku päälle (threshold 0).



varmistuksena jos Gemini ei toimi niin ajx ai toimii chat gpt halvimmalla versiolla. se pitää olla myös koodissa

\---

