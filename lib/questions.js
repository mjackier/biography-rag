// The 20 queries from the assignment. {person} is filled in at run time.
// `also` are extra search phrasings for the same question. They are generic on purpose: they add
// the words a biography would use for this topic, never a fact about any particular person, so
// nothing from a model's memory steers what gets retrieved.
export const QUESTIONS = [
  { n: 1, q: "Where and when was {person} born?", also: ["{person} was born in", "birth of {person}, birthplace, date of birth"] },
  { n: 2, q: "Where were {person}'s parents from, and what did they do?", also: ["{person}'s father and mother, their trade or occupation", "parents of {person} emigrated from, ancestry, family origins"] },
  { n: 3, q: "What was {person}'s childhood like?", also: ["{person} as a boy or girl, early years, youth", "when {person} was a child, growing up, play, home life"] },
  { n: 4, q: "Who were {person}'s siblings?", also: ["{person}'s brothers and sisters", "brother of {person}, sister of {person}, the children of the family"] },
  { n: 5, q: "What schooling or training did {person} have?", also: ["{person} went to school, education, teacher, studied", "{person} apprenticed, learned the trade, taught himself or herself, reading books"] },
  { n: 6, q: "What was {person}'s first job?", also: ["{person}'s first work, employment, apprenticeship", "{person} began working as, earned money, was employed by"] },
  { n: 7, q: "An adventurous story from {person}'s life.", also: ["{person} set out on a journey, voyage, adventure, ran away", "daring exploit of {person}, expedition, escaped"] },
  { n: 8, q: "A scary or dangerous moment {person} faced.", also: ["{person} in danger, narrowly escaped, nearly drowned or killed", "storm, shipwreck, attack, fire, threat to {person}'s life, fear"] },
  { n: 9, q: "A funny anecdote about {person}.", also: ["humorous story about {person}, joke, laughed, amusing", "{person}'s wit, jest, prank, comic incident"] },
  { n: 10, q: "A time {person} failed or made a serious mistake.", also: ["{person}'s error, blunder, failure, regretted, mistake", "{person} was wrong, lost, misjudged, fault, erratum"] },
  { n: 11, q: "The hardest thing {person} went through.", also: ["{person}'s grief, loss, death of a loved one, suffering", "{person}'s greatest trouble, hardship, illness, poverty, disgrace"] },
  { n: 12, q: "Who did {person} marry, and what was that relationship like?", also: ["{person}'s wife or husband, marriage, wedding", "{person} courted, married, the marriage, their life together"] },
  { n: 13, q: "What about {person}'s children?", also: ["{person}'s son, daughter, children", "{person}'s child was born, died, grew up, grandson"] },
  { n: 14, q: "Who were {person}'s closest friends or mentors?", also: ["{person}'s friend, companion, mentor, patron", "{person}'s intimate friendship, club, correspondence with friends"] },
  { n: 15, q: "Who were {person}'s rivals or enemies?", also: ["{person}'s enemy, opponent, rival, quarrel", "attacks on {person}, hostility, dispute, feud, opposed {person}"] },
  { n: 16, q: "What is {person} best known for?", also: ["{person} is famous for, renown, greatest achievement", "{person}'s fame, celebrated, reputation, remembered for"] },
  { n: 17, q: "Something {person} made, invented or discovered.", also: ["{person} invented, invention, discovery, experiment", "{person} devised, designed, built, founded, created"] },
  { n: 18, q: "Where did {person} travel or live?", also: ["{person} lived in, moved to, residence, home", "{person} travelled to, voyage to, sailed, visited, abroad"] },
  { n: 19, q: "A habit, hobby or quirk of {person}.", also: ["{person}'s habits, daily routine, peculiar, custom", "{person} enjoyed, amusement, pastime, liked to, rule of life"] },
  { n: 20, q: "How did {person} die, and how is {person} remembered?", also: ["death of {person}, died, last illness, funeral", "{person}'s memory, legacy, monument, honored after death"] },
];

export const fill = (s, person) => s.replaceAll("{person}", person);

// A canary is asked like any question; extra phrasings are just the question itself.
export const canaryQuestion = (text) => ({ n: 0, q: text, also: [] });
